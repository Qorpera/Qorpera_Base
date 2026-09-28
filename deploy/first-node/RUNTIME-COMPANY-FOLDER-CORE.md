# The company folder core

Status: design, not built. This is the storage core that the contract's
layout amendment ("the company folder layout", section 19) says must change
before any machine writes through the folder. It serves contract 5.6 and the
machine-side design in [the company folder on every machine](RUNTIME-COMPANY-FOLDER.md).
Where they differ, the contract governs.

Founder decisions it relies on:
- the folder is the company (contract 5.6);
- everything is approved by default, with the automatic review unchanged;
- a clean reset: today's companies are test companies, so nothing is migrated
  (layout amendment, 28 September 2026).

Because of the reset, this design replaces tables outright and carries no
backfill or dual mode.

The design rests on three read-only mapping reports of master at bundle v138
(write path, reads and wakes, projections and the reset). File references
below point to the live definitions they found.

## Goal

- Two changes to different files never conflict.
- A change can cover many files at once, and moves, renames, copies and
  deletes are part of it.
- No write does work that grows with the size of the company.
- No read takes a lock that covers the whole company.
- Wakes and clients follow one authorized list of changes.
- A saved structured file (contract 5.6) updates its index in the same step.

## What changes

| Today | In this design |
| --- | --- |
| One head per company (`qorpera_company_files.head_snapshot_id`); every write checks and moves it, and fails with PT409 after 4 tries | Each path has its own version; a change checks only the versions of the paths it touches |
| Every write rebuilds the full tree manifest (`qorpera.company-tree/v1`, 8 MiB, about 25,000 files), verifies it with an O(n²) parent check, stores a full jsonb copy, and records a reachability graph of every object in the company | A commit touches only its own paths. No manifest, tree copy or per-write graph exists |
| One path per operation (`qorpera.company-path-mutation/v1`) | A change set of units: write, mkdir, delete, move, copy |
| Every call, reads included, locks the profile row, the wake-admission fence and the Company File row `FOR UPDATE` (`qorpera_company_path_actor`, 20260920030500:371, 53 callers) | Reads take no company-wide lock. Effects share the company fence; only stop and garbage collection take it exclusively |
| Each run rechecks every path it read, one by one, under that lock (`qorpera_company_path_assert_context`) | Read sets are kept by covering resource, a few rows per run |
| Change events walk a linear chain of revisions, one path per event (`qorpera_drain_company_file_wakes`) | A journal with a per-company sequence number; one event lists all its units |
| Structured documents project only through proposals (`organization/*`, agent documents); side effects run inside the publish | One commit-time hook for every structured file, with side effects queued after the commit |

## 1. Data model

All tables are keyed by company environment.

- **Entries** (`qorpera_company_path_entries`, reshaped) hold the current
  folder.
  - Each row has: the path; a key derived from the path; the parent's key;
    `kind` (file or folder); an opaque `version`; and, for files, the file
    manifest hash, the file hash, the size, the media type and the executable
    bit.
  - It also records the commit that wrote it. Only live paths have rows.
  - An index on (parent key, name) serves listings. An index on the path
    (collation "C") serves whole-subtree ranges.
- **Path versions** (`qorpera_company_path_versions`) are immutable history,
  one row per version of a path.
  - Each row has: the operation (write, mkdir, delete, move out, move in,
    copy), the prior version, the file columns, the commit, and the unit
    number within the commit.
  - They serve restore, history views and the feed's unit list, and they are
    the retention roots for garbage collection.
- **Commits** (`qorpera_company_commits`), one row per change set.
  - Each row holds the attribution of contract 4.2: actor, requester,
    audience, run, sponsor, operation key, receipt or proposal, and runtime
    bundle.
  - It also holds each unit's outcome.
- **Journal** (`qorpera_company_journal`) gives each commit, and each
  authority change, a per-company sequence number `seq`.
- **Clock** (`qorpera_company_clocks`), one row per company, holds `last_seq`.
  It is also the Realtime hint for clients.
- **Upload intents** (`qorpera_company_upload_intents`) record bytes a writer
  is about to commit: file manifest, size, run or member command, operation
  key and expiry. They replace per-chunk authority calls, and they keep
  staged bytes alive until the commit or expiry.
- **Storage usage** (`qorpera_company_storage_usage`) moves off
  `qorpera_company_files`. It is updated outside the commit transaction.

No table keeps whole-company snapshots, publications, tree caches, revisions,
workspaces, substrate pins or company-root graphs (§9).

## 2. Commits

### Units

A change set is a list of units. Each unit is an atomic path set: it applies
whole or not at all.

| Unit | Checks |
| --- | --- |
| write | the path is absent, or at its expected version |
| mkdir | the path is absent |
| delete | the path is at its expected version; a folder takes its whole subtree |
| move | the source is at its expected version and the target is absent; a folder takes its subtree |
| copy | the target is absent |

A subtree delete or move has an implementation bound of 50,000 entries. It is
a defect in the sense of contract 5.5, and open question 1 says how it is
lifted.

### Before the transaction

The writer does this work, holding no locks:

1. It uploads the bytes under an upload intent. The object gateway verifies
   the chunks, as it does today.
2. It validates the plan: names, reserved prefixes, and the seeded-folder and
   `rules/` refusals of 5.6.
3. It checks authority for every unit.
4. For each structured file (§4), it reads the committed bytes back by hash,
   decodes them strictly, and parses them with the shared TypeScript parser.
5. It gives each unit a review class: plain, delegation or deletion. This
   replaces the tool-name table in `cloud-action-review.ts:148-209`.
   Delegation and deletion units go to the automatic review before the
   commit (contract 5.6).

### The transaction

The locks are taken in one fixed order, and nothing is locked after the
clock:

1. **The run.** The job row and the run are taken `FOR SHARE`.
2. **The company fence.** The profile row and the wake-admission fence are
   taken `FOR SHARE`. Stop, resume and GC deletion take them `FOR UPDATE`, so
   those still exclude every effect (see `qorpera_lock_profile_gc_fence`,
   20260907000700).
3. **Authority.** The covering resource and grant rows are taken `FOR SHARE`,
   sorted by id.
4. **Paths.** Every entry the change set touches is locked in one pass sorted
   by path key: targets `FOR UPDATE` and parent folders `FOR SHARE`. A missing
   parent is refused (PT424) unless an earlier unit of the same change set
   creates it.
5. **Objects.** Every object row a unit references is taken `FOR KEY SHARE`,
   sorted by hash.
6. **Indexes.** The index rows of structured files are locked by id, sorted
   (§4).
7. **Apply.** The clean units are applied, and entries, path versions, index
   rows and the commit row are written. A unit whose version check fails is
   not applied: nobody's work is overwritten, and its bytes stay on the
   receipt as a conflict copy.
8. **The clock.** `last_seq` is incremented, and the journal row is inserted
   with that number.

The clock row stays locked from step 8 until the transaction ends, which is
only the length of the final insert and the commit. So sequence order is
commit order, and a reader following the journal never skips an event.

What the transaction does not do:
- take the Company File row lock;
- compare any whole table;
- touch storage usage; or
- read the NAS.

The write-side cost of a commit grows only with its own units.

### Outcomes and replay

Each unit reports one of: saved, conflict, denied, waiting for review, or not
applied (RUNTIME-COMPANY-FOLDER.md §2). A repeated operation key returns the
stored outcomes and writes nothing.

### Who calls it

Every writer uses the same commit function:
- the runtime's Company File tools, until the mount's writes are accepted;
- the folder service (the mount);
- members through the object gateway;
- the Company Computer's saves;
- the reviewed-card approvals; and
- company creation.

## 3. Reads, authority and read sets

### Reads without the company lock

The read path:
- holds the job `FOR SHARE`;
- checks membership, employment, sponsor and pause with plain reads;
- answers from one statement snapshot; and
- takes no profile, fence or Company File lock.

The bytes are fetched after the transaction, as today, so no lock ever
covered them. Model requests and sends recheck release anyway.

- **Listings** page by (parent, name) with a key cursor, and can walk a whole
  subtree. They return `asOfSeq` instead of failing with "page changed". A
  client lists, then follows the journal from `asOfSeq`.
- **Byte-range reads** work on any file, text or binary. Decoding is the
  tool's job.

### Effects keep a narrow fence

Model requests, sends, writes and wakes across agents take `FOR SHARE` on the
covering resource rows in the run's read set, and on the member and staff
rows. An authority change takes `FOR UPDATE` on the resource it changes, and
on the covering parent when it inserts a narrower resource. So revocation
still cannot race a send, while effects no longer serialize one another.

### Explicit resources

Every basis becomes an explicit resource, seeded when the company or member is
created:
- the root;
- `members/<id>/private`, which today is an implicit rule in
  `qorpera_company_path_resource`;
- `rules/`, written by owners and admins only (contract 5.6);
- the code rules, each becoming a named basis: the notebook rule, the
  worker/todo rule, and the hiring rule.

The code rules must follow the agent's folder by id, not by UUID path.

### Read sets by covering resource

- **Storage.** A run's read set is one row per (run, resource, resource
  version, basis, names only). The exact paths read go into a per-command
  audit object (contract 9.1 read provenance).
- **Cost of a recheck.** It grows with the number of rows. Under the default
  grant, a whole-company search is one to three rows.
- **Narrower resources.** When one is inserted under a resource a run has read
  from, the run gets a row for it (the step-1 plan in the capability note),
  and only those paths are rechecked.
- **Per-row checks.** The wake, message, escalation and proposal checks
  (`wake_authorized`, `send_coworker_message`, `escalate_responsibility`,
  `list_company_path_proposals`) check per row.

## 4. Structured files and their indexes

`qorpera_structured_path_kind(path)` recognises the files that contract 5.6
gives a fixed format:
- `agents/<name>/agent.md`;
- `agents/sections.md`;
- `agents/<name>/routines/*.md` and `agents/<name>/todos/*.md`;
- `agents/groups/<name>/group.md`;
- `connections/*.md`;
- `rules/*.md`.

The same table is exported to TypeScript. An ordinary file pays for one
pattern match and nothing else.

- **Parsing.** The writer passes each structured file's text and parse into
  the commit. The limits are 64 KiB per file, 64 structured files and 1 MiB of
  structured text per change set. SQL re-hashes the text against the unit's
  file hash, then checks the parse against a closed schema and against rules
  that need database state:
  - an agent's `id` never changes;
  - the Co-Founder rules;
  - folder handles are unique;
  - referenced member and agent ids exist;
  - routine triggers are valid;
  - connection fields only the platform may write.
- **One step.** In the commit, the file's index row is written in the same
  step, and it points at the exact path version. This follows the template of
  today's organization projector (`qorpera_project_organization_document`,
  20260828022000:81; foreign keys at 20260828019200:6-43), minus its head
  check. A deferred check requires that every index row's path version is the
  entry's current version. An index row without its file is invalid.
- **Indexes.** They cover the agent roster (`qorpera_profile_staff`), group
  chats (rooms and members), sidebar sections, routines, todos, connections
  and company rules.
- **Refusals.** A file that fails is refused with its own typed error
  (`{path, field, reason}`), and the other units still land. A new agent
  folder is one unit, so an invalid `agent.md` refuses the whole folder.
- **Side effects after the commit.** Creating an agent's session, first run
  and grants, pausing an archived agent's routines, and revoking its secret
  grants go to a queue that a worker drains after the commit. Today they run
  inside the publish (`qorpera_project_company_agent_document`,
  20260828019600:528-615). An archived agent is still fenced at once, because
  run authority reads its index row's status.
- **Rebuild.** A rebuild operation recomputes every index from the folder, and
  a periodic check reports drift.

## 5. The journal, wakes and clients

- **Journal kinds.** A journal row is a change set (its units are the path
  versions of that commit) or an authority change (a resource or grant). The
  authority changes are new: today they are not events.
- **The feed.** `qorpera_company_feed(after_seq, limit)`:
  - returns the units the caller may read now;
  - hides names the caller cannot read;
  - returns "resync" past retention; and
  - never uses serialization error 40001, which PostgREST retries forever.
- **Wakes.** Listener cursors hold `processed_seq`. The drain reads a batch of
  journal rows after it and matches every unit, including a move's source
  path. Claims are keyed by (company, seq, trigger). A file wake carries its
  unit list. Listener activation captures `last_seq` from the clock.
- **The pin.** A wake's `companySnapshotId` becomes `companySeq`, meaning "the
  run was composed as of at least this commit". Reads stay live, as they are
  today. The transcript check (`qorpera_run_head_follows_session_pin`, which
  walks up to 4,096 revisions) becomes a comparison of sequence numbers.
  Substrate versions are no longer created per commit.
- **Clients.** The clock row replaces `qorpera_company_files` as the Realtime
  hint. On a hint, the web client asks the feed what changed instead of
  listing everything again. A saved `agents/sections.md` updates the sidebar
  index in the same step (contract 5.6), which replaces today's separate
  counter row.
- **Presence** already keys by covering resource
  (`presence_path_routes`, 20260908002700:28-63). It only loses its company
  locks.

## 6. Content storage

These stay:
- the flat content-addressed layout on the NAS (`<root>/<companyId>/<sha256>`);
- the 4 MiB chunk file manifests;
- the object catalog;
- the per-file verified proofs; and
- replication.

These change:
- File manifests gain the media type and the executable bit.
- The 256 MiB file cap is lifted by more chunks, or manifests of manifests.
- Uploads stream under an upload intent, instead of two full authority calls
  per chunk (20260828008000:4-45).
- The object gateway's limit of two NAS operations in flight per process
  (`object-store.ts:21`) is raised.
- A member upload with `p_tree=true`, which admits any hash, goes away with
  tree manifests.

## 7. Garbage collection and restore

- **Retention roots:** live entries; path versions within the restore window;
  open upload intents; conflict copies on receipts; open proposals; and
  retention holds. No commit writes a reachability graph.
- **Restore window:** 30 days. Git objects under `code/` are kept 7 days (the
  2026-09-27 amendment "every machine works in the company folder", item 9).
- **Deletion:**
  - GC deletes an object only after it has been unreferenced for longer than
    a grace window, which is longer than the longest read or upload.
  - Its delete batch takes the company fence `FOR UPDATE`.
  - Commits reference objects `FOR KEY SHARE` (§2, step 5), so an object in
    use cannot be deleted under a commit.
- This is the largest correctness risk of the design. It gets its own tests:
  - a read that races GC;
  - an upload that races GC;
  - a restore from the window's edge.

## 8. Locks, summarised

| Lock | Today | Here |
| --- | --- | --- |
| Company File row | every call, `FOR UPDATE` | never |
| Profile row + wake-admission fence | every call, `FOR UPDATE` | effects `FOR SHARE`; stop, resume and GC deletion `FOR UPDATE`; reads never |
| Job row | `FOR UPDATE`, which also serializes a run's own parallel reads | `FOR SHARE` |
| Entry rows | the one path, after the head | every path of the change set in key order; parents `FOR SHARE` |
| Clock | none | last, from the increment to the end of the commit |

The incident rules of 27 September hold: no new fence on a hot insert path,
narrow lock-order changes only, and activation checks that verify lock text
(20260927150000:1-37, 20260927130000, 20260927162900:89-110). Before the cut,
the load harness (`scripts/load-company-file-fence.mjs`) is extended to
change sets, parallel reads, GC and the feed, and it must show no deadlocks
and tool-call waits well under the 4-second result fence
(`cloud-native-result-fence.ts`).

## 9. What goes

Because of the clean reset, this goes without any migration:
- **Company File columns:** the head, the path-index snapshot and the
  canonical workspace columns on `qorpera_company_files`.
- **Snapshot and revision tables:** company snapshots, publications, the
  tree cache, path revisions, workspaces, company-root graphs and restore
  proofs, and substrate snapshot pins.
- **Snapshot columns** on sessions, runs, turns, wake claims, receipts and
  proposals. They are replaced by commit or sequence references.
- **The legacy snapshot lane:**
  - `qorpera_prepare/publish_company_file_revision`, `commit_company_snapshot`;
  - `submit/rebase/accept_company_proposal`, the runner revision lane;
  - `promote_company_file_graph_to_supabase`;
  - the `company-file-verifier` edge function;
  - the desktop callers in `cloud-client/src/hosted-primary.ts`.
- **Code that exists only for the head:**
  - the head and workspace guard triggers;
  - the substrate-per-head triggers;
  - the PT409 retry loops in the runtime and the object gateway;
  - every function patched by 20260927150000, all of which serve the legacy
    lane.
- **The old organization paths** `organization/agents|rooms|projects/*.json`
  and `organization/formation.json`, and their projectors. The structured
  files of §4 replace them.

## 10. Build plan

Every PR rides the release train and gets an independent review. Nothing is
activated for a company until the reset.

1. **Core schema and commit (C1).**
   - Entries, path versions, commits, journal, clock and upload intents.
   - The change-set commit function, and reads without the company lock.
   - Read sets by covering resource, and explicit resources.
   - SQL tests for every unit and outcome, plus concurrency tests for
     disjoint writes, same-path conflicts, subtree moves and deletes, and
     fence and stop interplay.
2. **Structured files and seeding (C2).**
   - The hook of §4 with its indexes, and the post-commit queue.
   - Company creation seeds the tree of contract 5.6 through one commit: the
     Co-Founder's folder and `agent.md`, `vision/vision.md`,
     `agents/sections.md` and the empty seeded folders.
3. **Runtime (C3).**
   - The Company File tools use change sets.
   - The memory, skills, todo, routine and hiring writers write files.
   - Review is classified by path.
   - The tools the layout amendment retires are removed, or become thin
     writers of the same files.
4. **Journal consumers (C4).**
   - The wake drain works on sequence numbers, and the pin becomes
     `companySeq`.
   - The feed, the Realtime hint, and the web client's file page and history
     view on path versions.
5. **The reset and the cut (C5).**
   - A service-role reset procedure. Today's product delete
     (`qorpera_delete_hosted_profile`, 20260818006000:41-68) fails for any
     company that has had a run, because of restrict foreign keys and
     triggers that refuse deletes.
   - Its exact scope goes to the founder for confirmation before it runs.
   - One owner runs the reset, the release is activated, and new test
     companies pass the acceptance of RUNTIME-COMPANY-FOLDER.md §10 and the
     launch items the layout amendment lists.

After C5, the mount's build steps continue from RUNTIME-COMPANY-FOLDER.md §9.
Step 1's reading side is largely delivered by C1 and C4. Step 4's writing side
is delivered by C1 to C3.

## Open questions

1. **Large subtree moves.**
   - Path-keyed entries make a folder move cost one row per descendant, so
     the design bounds it at 50,000.
   - Keying entries by id, with a parent and a name, would make moves cost
     one row. But every authority check would then have to rebuild paths.
   - Proposed: keep path keys, and revisit if real moves hit the bound.
2. **The clock.** One short row lock per commit and per company. If it
   becomes hot, it can be replaced by a watermark on transaction ids. A long
   transaction would then stall the feed.
3. **Member-private folders.** `members/<id>/private` exists in SQL but not in
   contract 5.6. Proposed: keep it as an explicit resource, and add one line
   to 5.6.
4. **Per-company personal settings.** Company memberships, personal review
   rules, sidebar pins and members' provider logins are stored per company,
   so the reset deletes them. Members then sign in again and reconnect their
   accounts in each new company. This is a founder decision (the reset scope).
