# The company folder core

Status: design, not built. This is the storage core that the contract's
layout amendment ("the company folder layout", section 19) says must change
before any machine writes through the folder. It serves contract 5.6 and the
machine-side design in [the company folder on every machine](RUNTIME-COMPANY-FOLDER.md).
Where they differ, the contract governs.

Founder decisions it relies on:
- the folder is the company (contract 5.6);
- everything is approved by default, and the automatic review is unchanged
  and classified by path on every agent write path;
- a clean reset: today's companies are test companies, so nothing is migrated
  (layout amendment, 28 September 2026);
- after the reset, members sign in again and reconnect their accounts in each
  new company (founder, 28 September 2026).

The design rests on three read-only mapping reports of master at bundle v139
(write path, reads and wakes, projections and the reset), and on two review
rounds. File references point to the live definitions they found.

## Goal

- Two changes to different files never conflict.
- A change can cover many files at once, and moves, renames, copies and
  deletes are part of it.
- No write does work that grows with the size of the company.
- No read takes a lock that covers the whole company.
- Revocation still cannot race an effect.
- Garbage collection never loses bytes that something still references.
- Wakes and clients follow one authorized list of changes.
- A saved structured file (contract 5.6) updates its index in the same step,
  and the automatic review is enforced in the database whatever carries the
  change.

## What changes

| Today | In this design |
| --- | --- |
| One head per company (`qorpera_company_files.head_snapshot_id`); every write checks and moves it, and fails with PT409 after 4 tries | Each path has its own version; a change checks only the versions of the paths it touches |
| Every write rebuilds the full tree manifest (`qorpera.company-tree/v1`, 8 MiB, about 25,000 files), verifies it with an O(n²) parent check, stores a full jsonb copy, and records a reachability graph of every object in the company | A commit touches only its own paths. No manifest, tree copy or per-write graph exists |
| One path per operation (`qorpera.company-path-mutation/v1`) | A change set of units: write, mkdir, delete, move, copy, and a new folder with its contents |
| Every call, reads included, locks the profile row, the wake-admission fence and the Company File row `FOR UPDATE` (`qorpera_company_path_actor`, 20260920030500:371, 53 callers) | Reads take no company-wide lock. Effects take the fence row `FOR KEY SHARE`; stop, resume and GC take it `FOR UPDATE` |
| Each run rechecks every path it read, one by one, under that lock (`qorpera_company_path_assert_context`) | Read sets are kept by covering resource with an authority revision, a few rows per run |
| Change events walk a linear chain of revisions, one path per event (`qorpera_drain_company_file_wakes`) | A journal with a per-company sequence number; one event lists all its units |
| Review is chosen by tool name in the runtime (`cloud-action-review.ts:148-209`) | Folder units are classified by path and by what changes, and SQL refuses an agent's reviewed unit without its review |
| Structured documents project only through proposals; side effects run inside the publish | One commit-time hook for every structured file; side effects converge after the commit |

## 1. Data model

All tables are keyed by company environment.

- **Entries** (`qorpera_company_path_entries`, reshaped) hold the current
  folder, one row per live path.
  - Each row has: the path; its casefolded key text; the parent's key; `kind`
    (file or folder); an opaque `version`; the commit that wrote it (`seq`);
    and, for files, the file manifest hash, the file hash, the size, the media
    type and the executable bit.
  - A folder row may be a **claim**: a placeholder that step 4 inserts for a
    path about to be created (§2). A claim that does not become live is
    removed in the same transaction.
  - An index on (parent key, name) serves listings. The key text in collation
    "C" gives ancestors-first order and whole-subtree ranges.
  - The primary key is the casefolded path, as today
    (20260828005000:8,68,74), so two spellings of one name collide.
- **Path versions** (`qorpera_company_path_versions`) are immutable history,
  one row per version of a path.
  - Each row has: the operation (write, mkdir, delete, move out, move in,
    copy), the prior version, the file columns, the commit, and the unit
    number.
  - They are kept for good: every change can be restored (the 2026-09-27
    amendment "every machine works in the company folder", item 6).
  - The one exception is git's own files under `code/` (the same amendment,
    item 9), whose old versions are pruned after 7 days.
  - Permanent erasure (contract 5.6) is the only other way a version goes.
- **Commits** (`qorpera_company_commits`), one row per change set. Each row
  holds:
  - the attribution of contract 4.2: actor, requester, approver, audience,
    run, causal wake, sponsor, provider connection, operation key, receipt or
    proposal, and runtime bundle;
  - each unit's outcome, and each unit's covering resource and authority
    revision.

  A unique index on (company, operation key) makes replay exact.
- **Journal** (`qorpera_company_journal`) gives each commit, and each authority
  change, a per-company sequence number `seq`, unique per company.
- **Clock** (`qorpera_company_clocks`) is one row per company holding
  `last_seq`. It is not indexed on `last_seq`, which keeps its updates HOT.
- **Upload intents** (`qorpera_company_upload_intents`) record bytes a writer is
  about to commit: the file manifest and its chunks, the size, the run or
  member command, the operation key, and an expiry that long uploads renew.
- **Objects** (`qorpera_profile_objects`, kept) gain two columns:
  `unreferenced_since`, and a `deleting` mark that GC sets (§7).
- **Storage usage** (`qorpera_company_storage_usage`) moves off
  `qorpera_company_files`. It is updated outside the commit transaction, and
  the upload quota trigger reads it there (today it locks the Company File
  row, 20260927150000:142-160).
- **The core flag.** `qorpera_company_files.core` is `snapshot-v1` or
  `folder-v2` (§10).

No table keeps whole-company snapshots, publications, tree caches, revisions,
workspaces, substrate pins or company-root graphs once the legacy code goes
(§9).

## 2. Commits

### Units

A change set is a list of units. Each unit is an atomic path set: it applies
whole or not at all.

| Unit | Checks |
| --- | --- |
| write | the path is absent, or at its expected version |
| mkdir | the path is absent |
| new folder with contents | the folder is absent; its contents are written with it |
| delete | the path is at its expected version. A folder takes its subtree, and every entry in it must be no newer than the unit's `asOfSeq` |
| move | the source is at its expected version and the target is absent. A folder takes its subtree, under the same `asOfSeq` rule |
| copy | the target is absent. Copying an `agent.md` or `group.md` whose `id` already exists is refused |

- **Unseen changes.** A subtree unit carries the `asOfSeq` at which its writer
  saw the subtree. A change it did not see makes the unit a conflict and
  nothing is deleted, so a delete never removes files its writer or reviewer
  never saw.
- **Case-only renames.** Renaming `Report.md` to `report.md` keeps the same
  key. It is a move within one row.
- **Bounds.** A subtree unit has an implementation bound of 50,000 entries.
  It is a defect in the sense of contract 5.5, and open question 1 says how it
  is lifted.

### Before the transaction

This work takes no locks. It is advisory, and the transaction repeats every
check that matters:

1. The writer uploads the bytes under an upload intent. The object gateway
   verifies the chunks, as it does today.
2. It validates names and reserved prefixes.
3. It reads each structured file's committed bytes back by hash, decodes them
   strictly, and parses them with the shared TypeScript parser.
4. It proposes each unit's review class.
5. An agent's delegation and deletion units go to the automatic review
   (contract 5.6). The review record binds the run, the change set's digest
   and the unit numbers.

### The transaction

Locks are taken in one fixed order, and nothing is locked after the clock.
Every function on the read, commit and effect paths uses explicit-mode
helpers: `qorpera_lock_company_fence(profile, mode)` and
`qorpera_lock_run_job(job, mode)`. They replace the implicit `FOR UPDATE`
helpers that are reachable today (`native_tool_locked_run` 20260828004000:31,
lease validation 20260912000400:24, `runner_broker_locked_job`
20260820002000:1529, and `qorpera_lock_profile_gc_fence` 20260907000700:7-27,
which about 79 migrations call). A transaction that needs an exclusive lock
takes it first. An activation check refuses any function that takes
`FOR UPDATE` on the fence row, a profile or a job after a shared lock.

The order:

1. **Claim the operation key**, through the unique index, so a replay stops
   here and returns the stored outcomes.
2. **The run.** The job is taken `FOR KEY SHARE`. Lease renewal takes
   `FOR NO KEY UPDATE`, which does not conflict with it, so renewal is never
   starved.
3. **The company fence.** The fence row is taken `FOR KEY SHARE`, never the
   profile row. Stop, resume and GC take the fence row `FOR UPDATE`. Wake
   admission becomes a plain update (`FOR NO KEY UPDATE`), so an effect in
   flight no longer makes admission skip (20260907000200:15-18).
4. **Principals and authority.** These are taken once, in one global order
   used everywhere: members, staff, resources, grants, each sorted by id.
   Each is taken in the strongest mode this transaction needs, because the
   structured units are known before BEGIN. A staff row the commit will
   rewrite as an index is taken `FOR UPDATE` here, never upgraded later. The
   commit then re-resolves every unit's covering resource and authorization
   after these locks; the pre-transaction check was only advisory.
5. **Paths.** One pass in ancestors-first order (casefolded key text,
   collation "C"):
   - Existing targets are taken `FOR UPDATE`, and parent folders `FOR SHARE`.
   - Absent targets are claimed in the same order, by inserting a claim row
     with `ON CONFLICT DO NOTHING`, then locking it.
   - A subtree unit locks its root `FOR UPDATE` at its place in the order,
     then lists and locks the children, repeating until no new entry
     appears. So a grandchild created under the subtree cannot escape it.
   - A missing parent is refused (PT424) unless an earlier unit of the same
     change set creates it.
   - The parent's spelling is re-read after its lock.
6. **Objects.** Every object row a unit references, manifest and chunks, is
   taken `FOR KEY SHARE`, sorted by hash. A row that is absent or marked
   deleting is refused (§7).
7. **Decide.** Each unit's outcome is decided from the locked rows, with no
   exception blocks. More than 64 subtransactions would overflow the snapshot
   cache, so failures are values, not errors. Here SQL also:
   - recomputes each agent unit's review class and refuses one without its
     review record (§3, *Review in SQL*);
   - applies the refusals of 5.6 (§4);
   - checks each structured unit's parse against its schema and database
     rules (§4).
8. **Apply.** Only the clean units are applied: entries, path versions, index
   rows (§4), the post-commit queue entries (§4) and the commit row. A unit
   whose version check failed is not applied: nobody's work is overwritten,
   and its bytes stay on the receipt as a conflict copy.
9. **Check.** An explicit check over the structured units confirms that every
   index row written points at its entry's current version. These tables have
   no deferred constraints or deferred triggers (an activation check verifies
   this), so nothing heavy runs at COMMIT.
10. **The clock.** `last_seq` is incremented, and the journal row is inserted
    with that number.

The clock row stays locked from step 10 until the transaction ends, which is
only the length of the final insert and the commit. A second committer can
read `last_seq` only after the first commit is visible, and an abort rolls its
increment back. So sequence order is commit order, and a reader following the
journal never skips an event.

What the transaction does not do:
- take the Company File row lock;
- compare any whole table;
- touch storage usage; or
- read the NAS.

The write-side cost of a commit grows only with its own units.

### Outcomes

Each unit reports one of:
- saved;
- conflict;
- refused (a rule of 5.6, or a structured file that fails its schema);
- denied (authority or review);
- waiting for review; or
- not applied (RUNTIME-COMPANY-FOLDER.md §2).

### Who calls it

Every writer uses the same commit function, as service_role:
- the runtime's Company File tools, until the mount's writes are accepted;
- the folder service (the mount);
- members through the object gateway, including the web editors for rules,
  sections, agent details, routines and group chats, which write files;
- the Company Computer's saves;
- the vault, when it writes a connection file in the same transaction as its
  secret record;
- the reviewed-card approvals; and
- company creation.

## 3. Reads, authority, review and read sets

### Reads without the company lock

The read path:
- takes no job lock, and checks the job, membership, employment, sponsor and
  pause with plain reads;
- answers from one statement snapshot; and
- takes no profile, fence or Company File lock.

The bytes are fetched after the transaction, as today, so no lock ever
covered them. Model requests and sends recheck release anyway. Taking no job
lock also stops a run's own parallel reads (memory reads 8 at a time,
`cloud-memory-tools.ts:60`) from waiting on each other.

- **Listings** page by (parent, name) with a key cursor, and can walk a whole
  subtree. Each page returns `asOfSeq`, read in the same statement as the
  page. A client lists, then follows the journal from the first page's
  `asOfSeq`.
- **Byte-range reads** work on any file, text or binary. Decoding is the
  tool's job.

### Authority revisions

Every resource gets an `authority_revision`. It is separate from `version`,
because grants are keyed by version (20260926035000:27). The revision is
bumped by:
- every revocation or grant removal;
- a policy change; and
- inserting a narrower resource under it, which bumps the covering parent.

A resource or grant change takes `FOR UPDATE` on the resource it changes, and
on the covering parent when it narrows, in the global order of §2 step 4. It
also writes an authority journal row.

### Effects keep a narrow fence

Model requests, sends, writes and wakes across agents take `FOR SHARE` on the
covering resource rows in the run's read set (§2 step 4), and compare each
row's recorded `authority_revision` with the current one.

- If they match, the effect goes ahead.
- If one changed, the effect re-resolves the paths recorded under that row
  (in the per-command audit object) against current authority, and refuses
  if any is no longer readable.

So a read that resolved an old covering resource can never carry past a
narrowing or revocation. And no resource change needs to write other runs'
rows, so the old fix-up scan and its reversed lock order go away.

### Explicit resources and bases

Every basis becomes an explicit resource or named basis, seeded when the
company or member is created:
- the root, with the default agent read/write grant (2026-09-26);
- `members/<id>/private`, which today is an implicit rule
  (`qorpera_company_path_resource`);
- `rules/`: owners and admins write it, every member and agent reads it;
- the code rules, each becoming a named basis that follows the agent's folder
  by `id`: the notebook rule, the worker/todo rule, and the hiring rule, whose
  create-only basis is the precondition "absent", enforced by the primary key;
- **by session kind:** in a coding session, `agents/**` and `rules/**` are
  read-only (contract 5.6).

### Review in SQL

Contract 5.6 requires the automatic review "whatever carries" an agent's
change. So the commit recomputes each unit's class at step 7 from the path,
the actor and session kind, and a diff of the base parse against the new
parse. The class is one of:

- **plain:** applies at once. This includes every member change, which is
  never reviewed;
- **delegation:**
  - a new agent folder;
  - an `agent.md` whose `status` changes to or from `archived`;
  - a new `group.md`;
  - creating, changing or deleting a routine file.

  The exception is the routine run's own end-of-run decision: the run's wake
  is that routine's occurrence, and only the decision fields (next run,
  conclusion, effort, reply policy) differ. That decision is plain unless it
  changes the instructions or the title;
- **deletion:** deleting or moving paths.

An agent's delegation or deletion unit without a matching review record
(allow, or an approved card, bound to the run, the change set's digest and the
unit numbers) is denied. One review covers a change set. Tools that act
outside the folder (connectors, the computer, workers, coding) keep their
tool-name classes in `cloud-action-review.ts`.

### Read sets and provenance

- **Rows.** A run's read set is one row per (run, resource, authority
  revision, basis, names only).
- **Provenance.** The exact reads go into a per-command audit object with
  what contract 9.1 requires: path, version, content hash, byte range or
  page, and output digest. `qorpera_company_read_observations`,
  `_read_confirmations` and `qorpera_native_context_views` are re-keyed from
  snapshots to path versions and commit numbers.
- **Cost of a recheck.** It grows with the number of rows. Under the default
  grant, a whole-company search is one to three rows.
- **Per-row checks.** The wake, message, escalation and proposal checks
  (`wake_authorized`, `send_coworker_message`, `escalate_responsibility`,
  `list_company_path_proposals`) check per row, with the same revision
  comparison.

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

### Parsing and schemas

The writer passes each structured file's text and parse into the commit.
- **Limits:** 64 KiB per file, 64 parsed files and 1 MiB of parsed text per
  change set. Moves do not count. The limits are defects in the sense of
  contract 5.5.
- **Checks in SQL:** SQL re-hashes the text against the unit's file hash,
  then checks the parse against a closed schema and against rules that need
  database state:
  - an agent's `id` never changes;
  - the Co-Founder rules;
  - folder handles are unique, casefolded;
  - referenced member and agent ids exist;
  - routine triggers are valid;
  - connection fields only the platform may write.

### The refusals of 5.6, enforced at commit

- Deleting or moving a seeded folder or file.
- Deleting a lone `agent.md` or `group.md`.
- Moving an agent's folder out of `agents/` or into `agents/groups/`, or a
  group's folder out of `agents/groups/`.
- The Co-Founder:
  - deleting its folder or `agent.md`;
  - archiving it;
  - giving `kind: co-founder` to another agent, or taking it away.

  The platform keeps the Co-Founder's `id` in `qorpera_company_cofounders`.
- Changing any agent's `id`, or copying one into a second folder.
- Deleting a connection file while its account is connected. Writing a
  connection's platform-only fields from anywhere but the vault.
- Writing `rules/` other than as an owner or admin. An agent may add only an
  Ask first personal rule, and that stays in the database.
- Writing `agents/**` or `rules/**` from a coding session.

### Index effect of each unit

- **Write of a structured file:** parse and upsert its index row, pointing at
  the new path version.
- **Move of a folder that contains structured files:** repoint their index
  rows to the new paths and versions, with no re-parse. An agent rename moves
  its routines and todos with it.
- **Delete:** mark the index row retired, pointing at the last version.
  Deleting an agent's folder retires its staff row: runs and sessions still
  reference it, and a retired row is exempt from the current-version check.
- **Restore:** re-parse, and bring the row back.
- **Copy:** parse as a new file; a duplicate `id` is refused.

The indexes cover the agent roster (`qorpera_profile_staff`), group chats
(rooms and members), sidebar sections, routines, todos, connections, company
rules, and the company name read from `vision/vision.md`.

### After the commit

Side effects are the agent's session, first run and grants, pausing an
archived agent's routines, and revoking its secret grants. Today they run
inside the publish (20260828019600:528-615). In this design they converge
after the commit:

- The commit writes a queue row per (company, subject).
- A worker locks the subject in the global order of §2 step 4, and converges
  it to the subject's current index row. It never replays events. A hire at
  sequence 10 processed after an archive at sequence 11 therefore leaves the
  agent archived.
- The worker is idempotent and runs at least once.

Some consumers must see a status change at once. They read the index row
directly and never wait for the worker: wake admission, routine firing, the
secret broker, coding admission, office screens and run authority. So an
archived agent is fenced at once.

### Rebuild

A rebuild operation recomputes every index from the folder, and a periodic
check reports drift.

## 5. The journal, wakes and clients

- **Journal kinds.** A journal row is a change set (its units are the path
  versions of that commit) or an authority change.
- **The feed.** `qorpera_company_feed(after_seq, limit)`:
  - returns the units the caller may read now;
  - hides names the caller cannot read;
  - returns "resync" past retention; and
  - never uses serialization error 40001, which PostgREST retries forever.
- **Wakes.**
  - Listener cursors hold `processed_seq`. The drain reads a batch of journal
    rows after it and matches every unit, including a move's source path.
  - Claims are keyed by (company, seq, trigger). A file wake carries its unit
    list.
  - Self-trigger fencing and causal ancestry stay as today
    (`qorpera_wake_ancestry`, 20260907000860:1053-1055): an agent's own commit
    never wakes its own subscription, and the commit's causal wake is on the
    commit row.
  - Listener activation reads `last_seq` from the clock row, so no event is
    missed or doubled.
- **The pin.** A wake's `companySnapshotId` becomes `companySeq`: the run was
  composed as of at least this commit. Reads stay live, as today. The
  transcript check (`qorpera_run_head_follows_session_pin`, which walks up to
  4,096 revisions) becomes a comparison of sequence numbers. Substrate
  versions are no longer created per commit.
- **Clients.**
  - The clock row replaces `qorpera_company_files` as the Realtime hint, and
    the hints are coalesced. `last_seq` reveals only that something changed.
  - On a hint, the web client asks the feed what changed instead of listing
    everything again.
  - A saved `agents/sections.md` updates the sidebar index in the same step,
    which replaces today's separate counter row.
- **Presence** already keys by covering resource
  (`presence_path_routes`, 20260908002700:28-63). It only loses its company
  locks.

## 6. Content storage

These stay:
- the flat content-addressed layout on the NAS (`<root>/<profileId>/<sha256>`,
  `object-store.ts:149`);
- the 4 MiB chunk file manifests;
- the object catalog;
- the per-file verified proofs; and
- replication.

These change:
- File manifests gain the media type and the executable bit.
- The 256 MiB file cap is lifted by more chunks, or manifests of manifests.
- Uploads stream under an upload intent that lists its chunks, instead of two
  full authority calls per chunk (20260828008000:4-45).
- The object gateway's limit of two NAS operations in flight per process
  (`object-store.ts:126`) is raised.
- A member upload with `p_tree=true`, which admits any hash, goes away with
  tree manifests.

## 7. Garbage collection and erasure

### Roots

An object is retained while it is referenced by any of:
- a live entry;
- a path version (versions are kept for good, apart from the `code/` git
  exception and erasure);
- an open upload intent;
- a conflict copy on a receipt;
- an open proposal or a unit parked on a review card (these never expire,
  2026-09-25 amendment, item 5); or
- a retention hold.

### Invariants

- **G1. References lock the object.** Every reference (intent, unit, conflict
  copy, proposal, hold, restore) takes `FOR KEY SHARE` on the manifest row and
  on every chunk row, and refuses rows that are absent or marked deleting.
  Intents list their chunks.
- **G2. GC marks before it unlinks.** GC locks the object row `FOR UPDATE`,
  re-checks every root in a new statement, and commits the `deleting` mark
  before any unlink.
- **G3. A deleting object is never "already there".** An upload never answers
  that a deleting or absent object exists: `put` asks the catalog first,
  unlike today's `object-store.ts:60`. The unlink goes through a quarantine
  rename and a final re-check, instead of today's unconditional `remove`
  (`:110-113`).
- **G4. Grace is measured from the last reference.** Each object keeps
  `unreferenced_since`, set when its last root ends and cleared on reuse. GC
  considers only objects past a grace window measured from that time, not
  from `created_at` (today's cutoff, 20260913000100:76). Long uploads renew
  their intents.
- **G5. The old gate goes last.** Today's company-wide gate
  (`qorpera_profile_gc_deletion_active`, 20260821009000:335-352) goes only
  once G1–G4 are built and tested.

Until C5, today's GC must never claim a `folder-v2` company's objects. From
C1, `qorpera_claim_company_object_gc` (20260913000100:68-130) skips them.

### Erasure

Permanent erasure (contract 5.6) is an owner or admin operation on a deleted
agent's folder. It removes that folder's path versions and marks the commits'
units erased, keeping their attribution. The bytes then lose their roots and
GC collects them.

### Tests

GC is the largest correctness risk of the design, so it gets its own tests:
- a read that races GC;
- an upload that races GC;
- the reuse of an old chunk;
- a restore of an old version; and
- erasure.

## 8. Locks, summarised

| Lock | Today | Here |
| --- | --- | --- |
| Company File row | every call, `FOR UPDATE` | never |
| Profile row | every call, `FOR UPDATE` | never on the read, commit or effect paths |
| Fence row | every call, `FOR UPDATE` | effects `FOR KEY SHARE`; wake admission `FOR NO KEY UPDATE`; stop, resume and GC `FOR UPDATE`; reads never |
| Job row | `FOR UPDATE`, which also serializes a run's own reads | commits and effects `FOR KEY SHARE`; renewal `FOR NO KEY UPDATE`; reads never |
| Members, staff, resources, grants | various, unordered | once, in one global order by id, in the strongest mode needed |
| Entry rows | the one path, after the head | every path of the change set, ancestors first; absent targets claimed in order |
| Clock | none | last, from the increment to the end of the commit |

**Stop, in two phases.** Stop first commits the pause, so new effects see it
and refuse. It then takes the fence row `FOR UPDATE`, which waits out the
effects in flight, and bumps the revision. A stream of shared lockers can
therefore not starve it.

**This is a broad lock-order change.** The incident notes of 27 September
warn against exactly that (20260927150000:1-37, 20260927130000). So:
- it applies only to `folder-v2` companies (§10);
- it ships behind activation checks that verify lock text
  (20260927162900:89-110);
- the explicit-mode helpers replace, rather than add, fence takers; and
- it is load-tested before any company uses it.

**The load test.** It extends `scripts/load-company-file-fence.mjs`, which
today runs on tmpfs, drives one sequential agent and excuses 55P03, to:
- run on a real disk;
- drive 32 to 64 concurrent runs mixing change sets, reads, listings, stop,
  wakes, ACL narrowing, subtree deletes and GC;
- count deadlocks, lock waits and multixact use (`pg_stat_slru`);
- check for authority leaks, missing parents and lost bytes; and
- measure stop latency and admission skips.

It passes only with no deadlocks, no leaks or losses, and tool-call waits well
under the 4-second result fence (`cloud-native-result-fence.ts`).

## 9. What goes, and when

Because of the clean reset, nothing is migrated. Old code is removed in C6,
after the reset (§10), because until then `snapshot-v1` companies still use
it:

- **Company File columns:** the head, the path-index snapshot and the
  canonical workspace columns on `qorpera_company_files`.
- **Snapshot and revision tables:** company snapshots, publications, the tree
  cache, path revisions, workspaces, company-root graphs and restore proofs,
  and substrate snapshot pins.
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
  - the legacy-lane functions patched by 20260927150000.

  The same migration also patched the upload quota trigger
  (`qorpera_enforce_company_storage_quota`), which stays, re-pointed at the
  usage row.
- **The old organization paths** `organization/agents|rooms|projects/*.json`
  and `organization/formation.json`, with their projectors.
- **Rewritten, not dropped:**
  - the observability functions on revisions (20260828019970:244,367);
  - the SQL tests in `scripts/test-*.mjs` that use snapshots;
  - the rollout templates that read the head
    (`scripts/runtime-rollout/templates/sql-packet.mjs:10-13`,
    `rehearse-wrapper.mjs:85-90`); and
  - the activation-template guards on dropped functions
    (`scripts/generate-cloud-runtime-bundle.mjs:169`).

## 10. Rollout and build plan

Master goes live at every release cut (RUNTIME-RELEASE-TRAIN.md), so new code
must be inert for today's companies until the reset. The per-company flag
`qorpera_company_files.core` does this:

- Every new function and code path runs only for `folder-v2` companies, and
  every existing path keeps serving `snapshot-v1` companies unchanged.
- Company creation makes `folder-v2` companies only when an operator asks for
  one, until C5.
- So one proof company can run on the new core in production before the reset.

This is a temporary code-level dual mode; there is still no data migration.

Every PR rides the release train and gets an independent review.

### C1. The core

- The schema of §1, with the flag.
- The change-set commit, with explicit-mode lock helpers and the activation
  checks of §8.
- Reads without the company lock.
- Authority revisions, read sets by covering resource, explicit resources
  and bases, and read provenance re-keyed.
- Review classification in SQL.
- GC for `folder-v2` (§7, G1–G4) and today's GC skipping `folder-v2`.
- Tests:
  - SQL tests for every unit and outcome;
  - concurrency tests: disjoint writes, same-path conflicts, absent-target
    claims, subtree moves and deletes with `asOfSeq`, fence and stop,
    admission and lease renewal, and ACL narrowing against sends;
  - GC race tests.

### C2. Structured files and seeding

- The hook of §4: schemas, indexes, the refusals and the converging queue.
- For `folder-v2` companies, creation seeds the tree of contract 5.6 in one
  commit: the Co-Founder's folder and `agent.md`, `vision/vision.md`,
  `agents/sections.md`, and the empty seeded folders.

### C3. Runtime and writers

For `folder-v2` companies:
- The Company File tools use change sets.
- The memory, skills, todo, routine and hiring writers write files.
- The vault writes connection files.
- The tools the layout amendment retires are removed from the model's tool
  list, or become thin writers of the same files.

### C4. Journal consumers and clients

- The wake drain works on sequence numbers, and the pin becomes `companySeq`.
- The feed and the Realtime hint.
- The web client's file page, history view and editors (rules, sections,
  agent details, routines, group chats) write and read files.
- Tolerant readers go out first:
  - the runner orchestrator accepts runs without snapshot or substrate ids
    (`orchestrator.ts:640-641`);
  - the object gateway serves `folder-v2` without tree manifests
    (`member-company-file.ts:794`, `company-bootstrap.ts:252`);
  - the edge functions handle `folder-v2` (runner-broker's verifier call
    `index.ts:348`, runner-control's `outputSnapshotId` `runner-control.ts:155`,
    member-company-gateway's snapshot route).

### C5. Proof, reset and switch

1. An operator creates one `folder-v2` proof company and runs the core
   acceptance below. The load test of §8 passes.
2. The reset procedure is written as a service-role function. Today's product
   delete (`qorpera_delete_hosted_profile`, 20260818006000:41-68) fails for any
   company that has had a run: restrict foreign keys and triggers refuse
   deletes.
3. Its exact scope goes to the founder for confirmation.
4. One owner runs it in a short maintenance pause, and company creation
   switches to `folder-v2` by default.

**Core acceptance (C5).** On a new company:
- the seeded tree exists;
- agents read, list, search and write through change sets, and disjoint
  writes never conflict;
- a same-path conflict keeps a conflict copy;
- a move and a subtree delete work;
- hiring, archiving, a routine file, a group chat and sections each update
  their index, and pass or skip review as 5.6 says;
- a coding session cannot write `agents/`;
- a file change wakes a listener exactly once;
- the web file page and history show the change;
- revocation stops a send;
- GC races lose nothing; and
- the launch items of the layout amendment that do not need the mount pass:
  3, 4, 5, 11, 15, 17, 19 and 21.

Items 6, 13 and 14 need the mount and the Company Computer, and are proven in
the mount steps.

### C6. Removal

Once no `snapshot-v1` company remains, the old code and tables of §9 are
removed, and the flag with them.

After C5, the mount's build steps continue from RUNTIME-COMPANY-FOLDER.md §9.
- Step 1's reading side is largely delivered by C1 and C4.
- Step 4's writing side is delivered by C1 to C3, except restore in the web
  app, streamed binary writes through the mount, and the upload binding for
  the folder service, which stay in step 4.

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
4. **"Delete company" in the product.** It calls
   `qorpera_delete_hosted_profile` (`web/src/cloud/api.ts:256`), which fails
   for any company that has had a run. Proposed: the C5 reset procedure
   becomes the product's delete for `folder-v2` companies. This is a founder
   decision.
