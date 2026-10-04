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
rounds, one on concurrency and one on contract fit. File references point to
the live definitions they found.

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
- Today's companies keep working, unchanged, until the reset.

## What changes

| Today | In this design (for `folder-v2` companies) |
| --- | --- |
| One head per company (`qorpera_company_files.head_snapshot_id`); every write checks and moves it, and fails with PT409 after 4 tries | Each path has its own version; a change checks only the versions of the paths it touches |
| Every write rebuilds the full tree manifest (`qorpera.company-tree/v1`, 8 MiB, about 25,000 files), verifies it with an O(n²) parent check, stores a full jsonb copy, and records a reachability graph of every object in the company | A commit touches only its own paths. No manifest, tree copy or per-write graph exists |
| One path per operation (`qorpera.company-path-mutation/v1`) | A change set of units: write, mkdir, new folder with contents, delete, move, copy |
| Every call, reads included, locks the profile row, the wake-admission fence and the Company File row `FOR UPDATE` (`qorpera_company_path_actor`, 20260920030500:371, 53 callers) | Reads take no company-wide lock. Nothing locks the profile row exclusively. Effects take the company's folder fence `FOR KEY SHARE`; stop and resume take it `FOR UPDATE` |
| Each run rechecks every path it read, one by one, under that lock (`qorpera_company_path_assert_context`) | Read sets are kept by covering resource and grant, each with a revision, a few rows per run |
| Change events walk a linear chain of revisions, one path per event (`qorpera_drain_company_file_wakes`) | A journal with a per-company sequence number; one event lists all its units |
| Review is chosen by tool name in the runtime (`cloud-action-review.ts:148-209`) | Folder units are classified by path and by what changes, and SQL refuses an agent's reviewed unit without its review |
| Structured documents project only through proposals; side effects run inside the publish | One commit-time hook for every structured file; the first run is written in the commit, and other side effects converge after it |

## 1. Two cores side by side until the reset

Master goes live at every release cut (RUNTIME-RELEASE-TRAIN.md). So the new
core must be inert for today's companies until the reset.

**The core flag.** `qorpera_company_files.core` is `snapshot-v1` or
`folder-v2`. It is set when the company is created and never changes. Until
C5, creation makes `folder-v2` companies only when an operator asks for one.
So one proof company can run on the new core in production before the reset.

**Separate tables.** The folder core uses its own tables (§2). Today's
Company File tables stay exactly as they are and keep serving `snapshot-v1`.
The exceptions are the path resources and grants, which both cores use and
which gain the revisions of §4 (see the table below). The tables that stay
unchanged include:
entries with their jsonb and tombstones, snapshots, revisions, and the
deferred triggers on them. So nothing that `snapshot-v1` relies on is
reshaped.

Tables that runs, wakes and sessions reference are shared by both cores. Each
gains `folder-v2` columns and guards:

| Shared table | For `folder-v2` |
| --- | --- |
| `qorpera_profile_staff` | the index of `agent.md`, with a source column pointing at `qorpera_folder_path_versions` |
| `qorpera_company_rooms` and room members | the index of `group.md` |
| routines, their versions and schedule cursors | the index of routine files; cursors stay runtime state |
| todos (which workers reference) | the index of todo files |
| review rules | company rules: the index of `rules/*.md`. Personal rules: rows, as today |
| sidebar sections and placements | the index of `agents/sections.md` |
| connection records (`qorpera_cloud_secrets`) | described by `connections/*.md`; the vault stays the authority (5.6) |
| path resources and grants | gain the revisions of §4 |
| wake occurrences and claims | gain commit and sequence references |
| read observations, read confirmations, context views | gain path-version and commit references (§4) |
| `qorpera_profile_objects` | gains `unreferenced_since` and `deleting` (§8) |

The old source foreign keys and old deferred triggers
(20260828019200:662-664, 20260828019600:698-700) skip `folder-v2` rows
through a narrow guard on the core flag. A `folder-v2` staff row leaves the
old source columns null, so its deferred foreign-key check at COMMIT is one
trivial event per row.

Readers of these tables that do not go through the actor branch on the core
flag: the routine scheduler, the reviewer's rule read, the worker and todo
functions, and the sidebar read.

**One dispatch point.** The 53 SQL callers of `qorpera_company_path_actor`
(sends, workers, escalation, presence, context views,
`begin_native_company_execution`, `complete_runner_job_v6` and the rest) reach
the Company File through that actor. The actor branches on the core flag:
- for `snapshot-v1` it is unchanged;
- for `folder-v2` it follows the lock rules of §3 and §9, and resolves
  authority from the folder core's tables.

C1 inventories every caller and records one decision for each:
- **Unchanged:** the actor's branch is enough.
- **Branches:** it touches snapshots, revisions or old organization paths
  directly, so it gets its own `folder-v2` branch.
- **Refuses:** it writes company state as rows with no file behind them.
  Examples:
  - `qorpera_manage_agent_routine` (20260922151000:201);
  - the review-rule RPCs (20260926130000:190,227) for `scope = 'company'`
    only. Personal rules and an agent's Ask first rule
    (`qorpera_add_agent_review_rule`, :806) stay rows, as contract 5.6 says;
  - the sidebar and room RPCs;
  - the object gateway's member `applyCommand`.

  For `folder-v2` these refuse, because contract 5.6 makes such a row
  invalid. Their callers write files instead (§11).

A SQL test calls every old writer on a `folder-v2` company and expects a
refusal.

**Locks follow the core.** Every lock change in this design applies only on
`folder-v2` paths. `snapshot-v1` paths keep today's exact lock text, and an
activation check compares that text with today's definitions.

This is a temporary code-level dual mode, not a data migration. The reset
(§11, C5) removes every `snapshot-v1` company, and C6 removes the old code,
the old tables and the flag.

## 2. Data model (folder-v2)

All tables are keyed by company environment.

- **Entries** (`qorpera_folder_entries`) hold the current folder, one row per
  live path.
  - Each row has: the path as written; `key_text`, the casefolded path with
    its own "C"-collation index, which gives ancestors-first order and
    subtree ranges; `key_sha256`, the primary key (as today's key: the sha256
    of the casefolded path, 20260828005000:68,74); the parent's key; `kind`
    (file or folder); an opaque `version`; the id of the commit that wrote
    it; and, for files, the file manifest hash, the file hash, the size, the
    media type and the executable bit.
  - **The folder key** is `qorpera_folder_key(path)`: NFKC, then case folding
    by Unicode simple case mapping pinned to the built-in `pg_c_utf8`
    collation, then NFKC again. The pin matters: a SQL function's case
    mapping follows its argument's collation, and the stored path is
    `collate "C"`, which folds ASCII only. Without it, a key generated from
    `Økonomi` would differ from one computed from request text (C1a review
    round 3). Resources are resolved by the same key
    (`qorpera_folder_path_resource`). When two resources share one folder key
    (possible while the shared unique key folds ASCII only), the path has no
    covering resource and only the platform reaches it. C1b-2's folder
    resource mutators refuse to create a tie. A plain unique index on the
    folder key is not added to the shared table, because snapshot-v1 rows may
    already collide (C1B §3). Lookups use an expression index on
    `(environment_id, qorpera_folder_key(path))`. `snapshot-v1` keeps today's key.
  - **After a PostgreSQL major upgrade**, the Unicode tables behind
    `normalize()` and `pg_c_utf8` case mapping may have changed. The runbook
    step: find entries and resources whose stored key differs from
    `qorpera_folder_key(path)`, and recompute them (`update ... set path =
    path`, which regenerates the keys) before the folder is served again.
    The same step reindexes the expression indexes on the folder key (the
    resources', the path versions' that erasure uses, P18, and P18b's
    `*_folder_key` indexes on staff, rooms, todos, routines and rules).
    `snapshot-v1`'s keys share the exposure.
  - A key is at most 2,600 bytes: `key_text` sits in two btree indexes, whose
    rows hold at most 2,704 bytes. A unit that would store a longer key, or
    a path over 4,096 bytes, is refused as `too_long`.
  - A row may be a **claim**: a placeholder that §3 step 5 inserts for a path
    about to be created. A claim that does not become live is removed in the
    same transaction.
  - An index on (parent key, name) serves listings.
- **Path versions** (`qorpera_folder_path_versions`) are immutable history,
  one row per version of a path.
  - Each row has: the operation (write, mkdir, delete, move out, move in,
    copy), the prior version, the file columns, the commit id and the unit
    number.
  - They are kept for good: every change can be restored (the 2026-09-27
    amendment "every machine works in the company folder", item 6).
  - The one exception is git's objects: the old versions of paths under
    `code/<owner>/<name>/repo.git/objects/` are pruned after 7 days (the same
    amendment, item 9; RUNTIME-COMPANY-FOLDER.md §6).
  - Permanent erasure (§8) is the only other way a version goes.
- **Commits** (`qorpera_folder_commits`), one row per change set. Its id is
  assigned at the start of the transaction.
  - Each row holds the attribution of contract 4.2: actor, requester,
    approver, audience, run, causal wake, sponsor, provider connection,
    operation key, receipt or proposal, and runtime bundle.
  - It also holds each unit's outcome, covering resource and authority
    revisions.
  - Its sequence number `seq` is written at the end (§3 step 11).
- **Operation keys** (`qorpera_folder_operation_keys`) hold one row per
  (company, operation key), with no foreign key to runs. The row is claimed at
  the start (§3 step 1).
- **Journal** (`qorpera_folder_journal`) gives each commit, and each authority
  change, a per-company `seq`, unique per company. The journal is kept for
  good.
- **Clock** (`qorpera_folder_clocks`) is one row per company holding
  `last_seq`. It is not indexed on `last_seq`, which keeps its updates HOT.
- **Fence** (`qorpera_folder_fences`) is one row per company: the stop and
  resume fence for `folder-v2`. It replaces the profile row and the
  wake-admission fence on `folder-v2` paths (§3, §9).
- **Admission** (`qorpera_folder_admissions`) is one row per company. Every
  transaction that inserts a wake takes it as its last lock before the clock
  (§3 step 10). It serializes wake admission and the wake count, which today
  sit on the fence (20260907000200:23-31).
- **Proposals** (`qorpera_folder_proposals`) hold parked units: units waiting
  on a review card, a restricted creator's hire (contract 14.1), or a
  protected path if one is ever configured. Each proposal keeps its unit list
  and its upload intents open until it is decided.
- **Upload intents** (`qorpera_folder_upload_intents`) record bytes a writer is
  about to commit: the file manifest and its chunks, the size, the run or
  member command, the operation key, and an expiry that long uploads renew.
- **Read sets** (`qorpera_folder_run_reads`) are keyed by covering resource and
  grant. Each row keeps the oldest authority revision the run has not yet
  rechecked (§4).
- **Read records** (`qorpera_folder_run_read_records`) hold one row per command
  and covering resource, written once, when the command's output is released.
  The row carries that command's reads as one sorted, compressed list of path,
  version, content hash, byte range or page, and the authority revision each
  read saw, plus the command's output digest. Writing once keeps a run's
  parallel reads from serializing on a shared row. A whole-company search is therefore a few
  rows, as RUNTIME-COMPANY-FOLDER.md §3 requires. SQL reads the list only when
  it re-resolves (§4).
- **Objects** (`qorpera_profile_objects`, shared) gain two columns:
  `unreferenced_since`, and a `deleting` mark (§8).
- **Storage usage** (`qorpera_folder_storage_usage`) is updated outside the
  commit transaction, and the upload quota trigger reads it for `folder-v2`.

## 3. Commits

### Units

A change set is a list of units. Each unit is an atomic path set: it applies
whole or not at all.

| Unit | Checks |
| --- | --- |
| write | the path is absent, or at its expected version |
| mkdir | the path is absent |
| new folder with contents | the folder is absent; its contents are written with it |
| delete | the path is at its expected version. A folder takes its subtree, and no entry in it may be newer than the unit's `asOfSeq` |
| move | the source is at its expected version and the target is absent. A folder takes its subtree, under the same `asOfSeq` rule |
| copy | the target is absent. Copying an `agent.md` or `group.md` whose `id` already exists is refused |

- **Unseen changes.** A subtree unit carries the `asOfSeq` at which its writer
  saw the subtree. A change it did not see makes the unit a conflict and
  nothing is deleted.
- **Case-only renames.** Renaming a file changes only its written spelling.
  Renaming a folder is a subtree unit, because every descendant's written
  path changes.
- **Bounds.** A subtree unit has an implementation bound of 50,000 entries.
  It is a defect in the sense of contract 5.5 (open question 1).

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
Within each row, the strongest mode a transaction needs is taken first; a lock
is never upgraded. The steps:

1. **Commit id and operation key.** The commit id is assigned and the
   operation key claimed. A replay stops here and returns the stored outcomes.
2. **The run.** For an effect that needs its run to itself (a tool call, a send, a receipt; not a commit or a
   release), the run mutex first: the run's budget row `FOR UPDATE` (C1C §5.2). Then the job is taken
   `FOR KEY SHARE`.
   - Lease renewal takes `FOR NO KEY UPDATE`, which does not conflict with
     it, so renewal is never starved.
   - Every change that ends a lease (requeue, cancel, handoff, completion,
     re-claiming an expired lease) takes `FOR UPDATE`, which waits for commits
     that checked the old lease. An activation check enforces this.
   - An approval applied after its run ended (a parked unit) takes no job
     lock. It never substitutes the approver for the agent (contract 4.3).
     The commit re-checks the agent's current authority and status, and the
     approver's right to answer the card. It records the agent as actor and
     the member as approver, and refuses the unit if either check fails.
   - **A view** (C1B "C1b-3: views" §4): the job of its live run, if any, then
     the view row `FOR KEY SHARE`, which closing and superseding (`FOR
     UPDATE`) wait for. Releases take them in the same order, and so must
     anything that locks two of them: the job, then the view, then the fence
     (step 3) and the principal rows (step 4).
3. **The folder fence.** The company's fence row is taken `FOR KEY SHARE`.
   - Stop and resume take it `FOR UPDATE`.
   - After this lock, the pause is read again, as today's rule requires
     (20260907000700:17-18). An effect that read "not paused" and then waited
     behind a stop refuses.
   - A transaction that inserts or admits a wake also takes the fence here and re-reads
     the pause, so stop's second phase waits out wake admission as well as
     effects. Today's rule is kept: "stop and resume must update the same
     persistent row that admission and effects lock" (20260907000700:1-3).
     Admission itself is serialized on its own row (step 10).
   - The profile row is never locked `FOR UPDATE` or `NOWAIT` on any
     `folder-v2` path (§9), except deletion's finisher and purge, after
     the fence `FOR UPDATE` (C1C §6.10).
4. **Principals, indexes, authority and uniques.** These are taken once, in
   one global order used everywhere:
   0. the company's profile row, `FOR KEY SHARE` (never stronger, and only this company's), in every
      save whose hook writes a roster row (C1b-3a; it was the head of rank 2 in F2-1). A roster write ends in a company
      operation: the operation clock, then a foreign key to `qorpera_profiles`. The thread trigger's
      session update is another one. On snapshot-v1, posting takes the profile row `FOR UPDATE` (gc fence)
      before the room and the clock, so the save takes the profile row first too (F2-1, #461; test
      701). On `folder-v2` (C1c-3a), posting takes the profile row `KEY SHARE` and its room `FOR SHARE`,
      so a save that changes a group chat meets it at the room instead (C1C §6.2). It comes before the members because #462's leave, remove and role change lock the
      profile row and then the member (C1B "C1b-3: views" §4). The commit refuses
      `qorpera_profiles` at any other rank;
   1. members;
   2. staff;
   3. execution authorities;
   4. rooms, then room members;
   5. the other index rows (sections, routines with their schedule cursors,
      todos, workers, human tasks, contacts, tables (P16), connections,
      rules), by table then id;
   6. resources, in ancestors-first order of their paths;
   7. grants;
   8. vault rows;
   9. unique-key claims, by kind then key.

   After rank 9 (C1C §5.7): run-owned rows (receipts, action reviews, context views); rank 10's recheck of read sets;
   every session the transaction will write, `FOR UPDATE` in id order: the conversations, then the coding sessions
   (C1c-3i), then the turn inputs, as C4's materializer (P28) takes them; and the company's operation
   clock, which the
   first session write takes (an insert, a title or status change, or an event). Admission and the folder clock stay last.

   These numbers are the lock ranks, and all nine come before paths (step 5),
   objects (step 6), admission (step 10) and the clock (step 11). The commit
   locks ranks 1, 3, 6 and 7 itself (members, execution authorities,
   resources, grants). For ranks 2, 4, 5, 8 and 9 it calls the structured-file
   hook, `qorpera_folder_structured_lock(targets, from_rank, to_rank)` (§5,
   agreed with F2 on #408). The hook's targets may also name rows of the
   commit's own tables. The commit merges those into its own pass at that rank,
   and the stronger mode wins. Each table has one owner, so rows of one table
   are always locked in one key order.

   Everything else in this step follows that order:
   - Rows a unit rewrites, staff included, are taken `FOR NO KEY UPDATE`. That
     does not block foreign-key inserts into the tables that reference them.
     Rows the commit only references are taken `FOR KEY SHARE`.
   - The index rows of every structured file inside a subtree unit (staff,
     rooms, room members and the rest) are locked here, from the unit's
     `asOfSeq` listing. So a subtree delete of `agents/x` never locks staff X
     after an entry.
   - Unique keys a unit introduces (a new agent `id`, a new handle) are
     claimed with `INSERT … ON CONFLICT DO NOTHING`, so a clash becomes an
     outcome at step 7, not an exception.
   - The vault never calls the commit (amended 3 October 2026, P22): a vault
     change marks its connection file due in its own transaction (an
     insert-only mark), and the object gateway's writer commits the file as
     the platform afterwards, converging it to the vault's current rows (as
     "After the commit" below). So no vault change waits for, or fails on, a
     file. (A commit can still write vault rows itself: hiring or archiving
     an agent grants or revokes its operations.)
   - The commit then re-resolves every unit's covering resource and
     authorization after these locks. The check before the transaction was
     only advisory.
5. **Paths.** Every row this change set locks is taken in one global
   ancestors-first order by `key_text` (refined in C1a, 2026-09-28).
   - Targets and sources are taken `FOR UPDATE`, a copy's source included
     (C1a review round 2): writers below it hold it `FOR KEY SHARE`, so the
     subtree cannot change between the checks and the copy.
   - A unit that creates a key lands on this change set's claim for it, or
     inserts the key outright when an earlier unit of the same change set
     removed it. Every apply counts the rows it placed and raises on a
     mismatch, so a lost write fails loudly.
   - **Every ancestor** of every target and source is taken `FOR KEY SHARE`,
     not just the parent.
   - Any absent row, target or ancestor, is claimed first by inserting a
     claim row with `ON CONFLICT DO NOTHING`, then locked. A second
     transaction then waits on the claim instead of missing it.
   - Because every write holds all its ancestors, a subtree unit locks only
     its root. While the root is held `FOR UPDATE`, nothing inside the subtree
     can change and nothing can be created under a claimed target. So a
     grandchild cannot escape, and no descendant has to be locked one by one.
   - No update ever changes a row's key: a move deletes and re-inserts. A
     READ COMMITTED locking read that follows an update chain keeps its lock on
     the row's new version, which would sit at a key out of order and deadlock.
   - A missing parent is refused (PT424) unless an earlier unit of the same
     change set creates it.
   - A new name takes its existing parent's written spelling.
6. **Objects.** Every object a unit newly references (writes, copies, conflict
   copies) is taken `FOR KEY SHARE`, manifest and chunks, sorted by hash. A
   row that is absent or marked deleting is refused (§8). A move references
   nothing new and takes no object locks.
7. **Decide.** Each unit's outcome is decided from the locked rows, with no
   exception blocks. More than 64 subtransactions would overflow the snapshot
   cache, so failures are values, not errors. Here SQL also:
   - recomputes each agent unit's review class (§4, *Review in SQL*);
   - applies the refusals of 5.6 (§5);
   - checks each structured unit's parse against its schema and database
     rules (§5).
8. **Apply.** Only the clean units are applied: entries, path versions, index
   rows (§5), the queue rows (§5) and the commit row. A unit whose version
   check failed is not applied: nobody's work is overwritten, and its bytes
   stay on the receipt as a conflict copy.
9. **Check.** An explicit check over the structured units confirms that every
   index row written points at its entry's current version. The folder core's
   tables have no deferred constraints or deferred triggers; an activation
   check verifies this for them. So nothing heavy runs at COMMIT.
   - **The anchor step, for a view** (C1B "C1b-3: views" §3, §4): the view's
     anchor `FOR SHARE` (the screen or the coding session), then the view's
     full validity re-checked in a new statement. It comes after the check and
     before admission and the clock, so it is held only to the end.
10. **Admission.** If the transaction inserts a wake, it takes the company's
    admission row `FOR NO KEY UPDATE` as its last lock before the clock, and
    inserts its wakes after it. That covers:
    - the post-commit worker's first runs, and the creation's first run once
      C4 (P28) materializes it (the creation commit itself writes the
      kickoff and its turn request, no wake: CREATION §3);
    - sends, room posts and escalations that wake an agent;
    - routine firing, the materializer and the file drain.

    How today's wake producers comply on `folder-v2`:
    - The wake pin trigger no longer admits at insert
      (20260907000200:23-28).
    - Its callers first take the recipient's member, staff and execution
      authority rows in step 4's order and mode, then admission here.
    - The materializer locks members and staff before admission, not after
      (20260920030500:160-169).
    - Routine firing locks its routine row and cursor at their place in
      step 4.

    Transactions that insert no wake never take the admission row, so they
    never block admission and admission never blocks them. The lock is held
    only until the commit ends.
    - A loop that admits wakes for many companies handles exactly one company
      per transaction, in sorted order. It never holds several companies'
      locks in one transaction, not even with `NOWAIT` on the admission row:
      locks taken in completed subtransactions stay held until the top-level
      commit, so two loops and two workers could form a cycle (40P01).
    - A transaction that inserts no wake skips this step.
11. **The clock.** `last_seq` is incremented. The commit row gets its `seq`,
    and the journal row is inserted with it.

The clock row stays locked from step 11 until the transaction ends, which is
only the length of two small writes and the commit. A second committer can
read `last_seq` only after the first commit is visible, and an abort rolls its
increment back. So sequence order is commit order, and a reader following the
journal never skips an event.

What the transaction does not do:
- lock the profile row or any whole-company row exclusively;
- compare any whole table;
- touch storage usage; or
- read the NAS.

The write-side cost of a commit grows only with its own units.

### Outcomes

Each unit reports one of:
- saved;
- conflict;
- refused (a rule of 5.6, a structured file that fails its schema, or a
  path the unit would store past the 4096-byte limit, `too_long`);
- denied (authority, or a reviewed unit without its review);
- waiting for review (its review record is a pending ask, and the unit is
  parked as a proposal);
- not applied (RUNTIME-COMPANY-FOLDER.md §2).

### Who calls it

Every writer uses the same commit function, as service_role:
- the runtime's Company File tools, until the mount's writes are accepted;
- the folder service (the mount);
- members through the object gateway, including the web editors for rules,
  sections, agent details, routines and group chats, which write files for
  `folder-v2`;
- the Company Computer's saves;
- the vault's connection-file writer in the object gateway, for connection
  files (P22: after the vault change, from its due marks);
- the reviewed-card approvals;
- a card's "Always allow" answer, which writes `rules/<rule>.md` as the
  answering owner or admin (2026-09-25 amendment, item 5); and
- company creation.

## 4. Reads, authority, review and read sets

### Reads without the company lock

The read path:
- takes no job, fence, profile or other company-wide lock;
- checks the job, membership, employment, sponsor and pause with plain reads;
  and
- answers from one statement snapshot.

The bytes are fetched after the transaction, as today, so no lock ever
covered them. Model requests and sends recheck release anyway. Taking no job
lock also stops a run's own parallel reads from waiting on each other.

- **Listings** page by (parent, name) with a key cursor, and can walk a whole
  subtree. Each page returns `asOfSeq`, read in the same statement as the
  page. A client lists, then follows the journal from the first page's
  `asOfSeq`.
- **Byte-range reads** work on any file, text or binary. Decoding is the
  tool's job.

### Authority revisions

Authority carries two kinds of revision:
- **structural**, on each resource: bumped by a policy change and by inserting
  a narrower resource under it (which bumps the covering parent); and
- **grant**, on each grant row: bumped when that principal's grant is
  narrowed or removed.

Removing one agent's grant therefore touches only that agent's runs.

A resource or grant change takes `FOR NO KEY UPDATE` on the rows it changes,
and on the covering parent when it narrows, in the global order of §3 step 4.
It also writes an authority journal row.

### Effects keep a narrow fence

Before locking, an effect reads the pause flag and refuses at once if the
company is paused. It reads the flag again after the fence lock (§3 step 3).
Otherwise, model requests, sends, writes and wakes across
agents take `FOR SHARE` on the read set's covering resource and grant rows
(§3 step 4), and compare the oldest unchecked revision recorded in each
read-set row with the current one. A new read under a row never raises that
recorded revision: the row keeps `least(recorded, observed)`.

- If they match, the effect goes ahead.
- If one changed, SQL re-resolves, against current authority, only the paths
  under the changed resource's prefix, taken from the run's read records:
  - it refuses if any path is no longer readable;
  - it adds a row for any newly found narrower resource, locking it in the
    same transaction; and
  - only after a successful re-resolution, it re-stamps the rows with the
    current revisions, as a compare-and-set on the value it read
    (`where revision = <read value>`). If a release of another command in the
    same run lowered the value meanwhile, the re-stamp does nothing, and the
    next effect re-resolves again. So the work is done once per change, and
    a lowered revision is never overwritten.

  A release that finds a changed revision re-resolves its own command's reads
  together with the read record it is writing.

A read therefore never carries past a narrowing or revocation. No resource
change writes other runs' rows, so the old fix-up scan and its reversed lock
order go away.

### Explicit resources and bases

Every basis becomes an explicit resource or named basis, seeded when the
company is created:
- the root, with the default agent read/write grant (2026-09-26);
- `rules/`: owners and admins write it, every member and agent reads it;
- the code rules, each becoming a named basis that follows the agent's folder
  by `id`:
  - the notebook rule;
  - the worker/todo rule;
  - the hiring rule, whose create-only basis is the precondition "absent";
- **by session kind:** in a coding session, `agents/**` and `rules/**` are
  read-only (contract 5.6).

`snapshot-v1`'s implicit `members/<id>/private` rule is not carried over:
`folder-v2` has no `members/` folder (open question 3).

### Review in SQL

Contract 5.6 requires the automatic review "whatever carries" an agent's
change. So the commit recomputes each unit's class at step 7 from the path,
the actor and session kind, and a diff of the base parse against the new
parse. The class is one of:

- **plain:** applies at once. This covers:
  - every member change;
  - every coding-session change that passes the `agents/**` and `rules/**`
    refusal (coding sessions are never reviewed, contract 5.6);
  - a routine run's own end-of-run decision: the run's wake is that routine's
    occurrence, and only the decision fields (next run, conclusion, effort,
    reply policy) differ;
- **delegation:**
  - a new agent folder;
  - an `agent.md` whose `status` changes to or from `archived`;
  - a new `group.md`;
  - creating or deleting a routine file, or changing it other than by its own
    end-of-run decision;
- **deletion:** deleting or moving paths.

An agent's delegation or deletion unit is handled by its review record:
- **allow**, or an approved card: the unit applies;
- **pending ask:** the unit waits for review and is parked as a proposal;
- **none, or deny:** the unit is denied.

One review covers a change set. Tools that act outside the folder
(connectors, the computer, workers, coding) keep their tool-name classes in
`cloud-action-review.ts`.

### Read provenance

The exact reads go into the run's read records (§2) with what contract 9.1
requires: path, version, content hash, byte range or page, and output digest.
The read observations, read confirmations and context views
(`qorpera_company_read_observations`, `_read_confirmations`,
`qorpera_native_context_views`) gain `folder-v2` columns that point at path
versions and commit ids instead of snapshots.

- **Cost of a recheck.** Without a change, it grows with the number of
  read-set rows. Under the default grant, a whole-company search is one to
  three rows.
- **Per-row checks.** The wake, message, escalation and proposal checks
  (`wake_authorized`, `send_coworker_message`, `escalate_responsibility`,
  `list_company_path_proposals`) check per row, with the same revision
  comparison.

## 5. Structured files and their indexes

`qorpera_structured_path_kind(path)` recognises the files that contract 5.6
gives a fixed format:
- `agents/<name>/agent.md`;
- `agents/sections.md`;
- `agents/<name>/routines/*.md` and `agents/<name>/todos/*.md`;
- `agents/groups/<name>/group.md`;
- `connections/*.md`;
- `rules/*.md`;
- `human-tasks/*.md` and `contacts/*.md` (F2's H1; STATE-FILES §2, indexed since H2);
- `interfaces/order.md`, `interfaces/*/interface.toml`, `tables/*/table.toml` and `tables/*/rows.csv` (P16;
  RUNTIME-INTERFACES.md §6.1, with a table index and no interface index before I7).

STATE-FILES §1 also lists `vision/vision.md` and the worker files. The same table is exported to
TypeScript. An ordinary file pays for one
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
  - a new agent or group folder's name follows the handle rule of 5.6,
    whoever creates it;
  - handles are unique, casefolded;
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
- Writing `rules/` other than as an owner or admin. An agent's Ask first
  personal rule stays in the database.
- Writing `agents/**` or `rules/**` from a coding session.

### Index effect of each unit

- **Write of a structured file:** parse and upsert its index row, pointing at
  the new path version.
- **Move of a folder that contains structured files:** repoint their index
  rows to the new paths and versions, with no re-parse. An agent rename moves
  its routines and todos with it.
- **Delete:** mark the index row retired, pointing at the last version.
  Deleting an agent's folder retires its staff row. Runs and sessions still
  reference it, and a retired row is exempt from the current-version check.
- **Restore:** re-parse, and bring the row back.
- **Copy:** parse as a new file; a duplicate `id` is refused.

The indexes cover the agent roster (`qorpera_profile_staff`), group chats
(rooms and members), sidebar sections, routines, todos, connections, company
rules, and the company name read from `vision/vision.md`.

### Company creation is one commit

Company creation for `folder-v2` seeds the tree of contract 5.6 in one commit:
- the Co-Founder's folder and `agent.md`;
- `vision/vision.md` and `agents/sections.md`;
- the empty seeded folders.

The same transaction writes the Co-Founder's staff row and exactly one silent
first-run kickoff with its turn request (launch item 3); the first-run wake
comes when C4 (P28) materializes that turn. The company stays hidden until the
creation is completed, and, once P15's queue exists, until the queue has
converged its other side effects, as today's bootstrap job keeps a company
hidden (`qorpera_finalize_company_bootstrap`). How creation runs (the
creation row, the worker, the operator's path):
`RUNTIME-COMPANY-FOLDER-CREATION.md`.

### After the commit

Other side effects converge after the commit:
- an agent's session, grants and first run, for hires after creation;
- pausing an archived agent's routines;
- revoking its secret grants.

Today they run inside the publish (20260828019600:528-615). In this design:
- The commit writes a queue row per (company, subject).
- A worker takes the fence (§3 step 3), then locks the subject in the global
  order of §3 step 4, and converges it to the subject's current index row.
  It never replays events. A hire at sequence 10 processed after an archive
  at sequence 11 leaves the agent archived.
- The worker is idempotent and runs at least once.

Some consumers must see a status change at once. They read the index row
directly and never wait for the worker: wake admission, routine firing, the
secret broker, coding admission, office screens and run authority. So an
archived agent is fenced at once.

### Rebuild

A rebuild operation recomputes every index from the folder, and a periodic
check reports drift.

## 6. The journal, wakes and clients

- **Journal kinds.** A journal row is a change set (its units are the path
  versions of that commit) or an authority change.
- **The feed.** `qorpera_folder_feed(after_seq, limit)`:
  - returns the units the caller may read now;
  - hides names the caller cannot read; and
  - never uses serialization error 40001, which PostgREST retries forever.

  The journal is kept for good, so "resync" is returned only for an invalid
  cursor.

  As built in C1f (`20260928237000_folder_core_feed`):
  - The signature is `qorpera_folder_feed(env, actor, after_seq, limit,
    cursor)`. It is for service_role only. Its actors are the platform, a
    member and a run, resolved as `qorpera_folder_read` resolves them; view
    actors come with C1b-3.
  - A position is `after_seq` (every seq up to it is done) plus an optional
    `cursor {unitNo, version}` inside seq `after_seq + 1`. A subtree move can
    touch 100,000 paths, so a page may stop inside a change set. A change set
    is whole in the reader's hands once `next.afterSeq` has reached its seq.
  - Changes are ordered by `(unit_no, version)`. The order within a unit is
    stable but has no meaning: a unit is one atomic path set.
  - Each call examines at most `limit` changes and authority rows, readable or
    not. A member's page may therefore hold fewer events, or none, and still
    advance. A change set none of whose paths the actor may read is left out.
    A move's `priorVersion` is shown only when the actor may read the source.
  - Each page returns `asOfSeq`, `next {afterSeq, cursor}` and `more`. A
    current version's `updatedAt` is its entry's, as read and list report it;
    a superseded version carries none.
  - The clock is service_role's to poll: `select` on `qorpera_folder_clocks`.
    It is not published to Realtime: as we read `realtime.apply_rls`,
    Realtime sends every subscriber that may not select a published table an
    "unauthorized" event per change, which would show any client the timing
    of every commit. Members' and
    clients' own hints come with C4.
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
  4,096 revisions) becomes a comparison of sequence numbers. No substrate
  version is created per commit.
- **Clients.**
  - The clock row is the hint: the node's folder service polls it (C1f), and
    C4 gives members and clients a hint of their own. Hints are coalesced.
    `last_seq` reveals only that something changed.
  - On a hint, the web client asks the feed what changed instead of listing
    everything again.
  - A saved `agents/sections.md` updates the sidebar index in the same step.
- **Presence** already keys by covering resource
  (`presence_path_routes`, 20260908002700:28-63). It uses the actor's
  `folder-v2` branch and takes no company locks.

## 7. Content storage

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
- For `folder-v2`, a member upload with `p_tree=true`, which admits any hash,
  does not exist.

## 8. Garbage collection and erasure

### Roots

An object is retained while it is referenced by any of:
- a live entry;
- a path version (kept for good, apart from the git-object exception and
  erasure);
- an open upload intent;
- a conflict copy on a receipt;
- an open proposal, including units parked on a review card, which never
  expire (2026-09-25 amendment, item 5); or
- a retention hold.

### Invariants

- **G1. References lock the object.** Every new reference (intent, write,
  copy, conflict copy, proposal, hold, restore) takes `FOR KEY SHARE` on the
  manifest row and every chunk row, and refuses rows that are absent or
  marked deleting. Intents list their chunks.
- **G2. GC marks before it unlinks.** GC locks the object row `FOR UPDATE`,
  re-checks every root in a new statement, and commits the `deleting` mark
  with its lease token before any unlink. Its final re-check before the
  unlink runs under the object row lock and checks that its lease token is
  still current, so a GC that outlived its lease never unlinks.
- **G3. A deleting object is never "already there".** GC holds a lease with an
  expiry on each object it deletes. A new reference to a hash marked
  deleting, an upload's included, is refused: as a conflict (the runtime's
  QRC01 409 envelope; never 40001) by staging and replication, as missing by
  a download, and as `bytes_unverified` by a commit. The writer redoes its
  call once GC has finished or the lease has expired; an expired lease is no
  mark. `put` itself is unchanged: every route that writes into a `folder-v2`
  company's NAS path refuses `folder-v2` before its put, and the folder byte
  path checks the mark after the catalog row's lock where it takes one (the
  upload's authorization reads plainly, and its committed intent is a root)
  (amended 2026-10-01, F1 and F2, #605;
  C1d-2a's per-route tests are the evidence, and 3m checks it). The unlink
  goes through a quarantine rename and a final re-check. If the re-check
  finds a root, GC clears the mark and restores the bytes from quarantine;
  otherwise it removes them. There is no unconditional `remove` as at
  `:110-113`. `snapshot-v1` companies see no change.
- **G4. Grace is measured from the last reference.** Each object keeps
  `unreferenced_since`, set when its last root ends and cleared on reuse. GC
  considers only objects past a grace window measured from that time, not
  from `created_at` (today's cutoff, 20260913000100:76). Long uploads renew
  their intents.

With G1–G4 in place, GC for `folder-v2` takes no company fence and needs no
company-wide gate. Today's gate (`qorpera_profile_gc_deletion_active`,
20260821009000:335-352) stays for `snapshot-v1`. From C1, today's GC
(`qorpera_claim_company_object_gc`, 20260913000100:68-130) never claims a
`folder-v2` company's objects.

### Erasure

Permanent erasure (contract 5.6) is an owner or admin operation on a deleted
path: a deleted agent's folder, or any other deleted path, such as a contact's
file (contract, the 2026-10-02 amendment "work for people", item 3). It
removes that path's versions and the conflict copies of its paths, removes or
clears the retired index rows built from them, and blanks the path names (and
problem texts that quote them) in the commits' units, keeping the commits'
attribution. A file's history that runs through moves is erased whole or not
at all. The bytes then lose their roots, and GC collects them. Design:
RUNTIME-COMPANY-FOLDER-ERASURE.md (slice P18).

### Tests

GC is the largest correctness risk of the design, so it gets its own tests:
- a read that races GC;
- an upload that races GC;
- the reuse of an old chunk;
- a quarantine re-check that finds a root;
- a restore of an old version; and
- erasure.

## 9. Locks, summarised (folder-v2)

| Lock | Today | folder-v2 |
| --- | --- | --- |
| Company File row | every call, `FOR UPDATE` | never |
| Profile row | every call, `FOR UPDATE` | never `FOR UPDATE` or `NOWAIT`, on any path. Foreign-key inserts take their KEY SHARE, which nothing now blocks |
| Folder fence row | not present (the wake-admission fence, `FOR UPDATE`) | effects, wake admission and the post-commit worker `FOR KEY SHARE`; stop and resume `FOR UPDATE`; reads and GC never. A loop over several companies handles one company per transaction, or takes every company's fence in one transaction in company-id order: `FOR KEY SHARE` and nothing stronger of any company (the node-update steps, C1C §6.15), or `FOR UPDATE` (deletion's finisher batch, C1C §6.10) |
| Admission row | not present | every wake-inserting or wake-admitting transaction `FOR NO KEY UPDATE`, last before the clock; multi-company loops one company per transaction |
| Job row | `FOR UPDATE`, which also serializes a run's own reads | commits and effects `FOR KEY SHARE`; renewal `FOR NO KEY UPDATE`; lease-ending changes `FOR UPDATE`; reads never |
| Members, staff, rooms, index rows, resources, grants, vault rows, unique claims | various, unordered | once, in the order of §3 step 4: `FOR NO KEY UPDATE` for rows rewritten, `FOR KEY SHARE` for rows referenced. One exception: a member's post, a room delivery's retry and a member's answer in an agent's thread take their room `FOR SHARE` (C1C §6.2, §6.3) |
| Entry rows | the one path, after the head | targets and sources, plus every ancestor `FOR KEY SHARE`, in one ancestors-first order; absent rows claimed in order; a subtree unit locks only its root; no update changes a key |
| Clock | none | last, from the increment to the end of the commit |

**No exclusive lock on the profile row.** Effects insert rows whose foreign
keys point at `qorpera_profiles`, so a function that locked the profile row
`FOR UPDATE` and then the fence would deadlock against them (the pattern in
20260927150000:4-9). So on a `folder-v2` company, no path takes the profile
row `FOR UPDATE` or `NOWAIT`, whether new or old. The one exception is
deletion's finisher and purge (C1C §6.10): they take the fence `FOR UPDATE`
first, so no effect holds the row while they wait, and the purge deletes
the row. That covers:
- `qorpera_lock_profile_gc_fence` (20260907000700:7,14), which about 79
  migrations call;
- the direct sites: 20260926130000:204,806, 20260907000200:15,
  20260908001900:39 and 20260920030500:540.

On `folder-v2`, each of these uses the folder fence in the mode its caller
needs.

C1 records a decision for each fence caller:
- **shared** (effects);
- **exclusive** (stop and resume only); or
- **moved** to a narrower lock of its own. The wake count (20260907000200:30-31)
  moves to the admission row, and rule inserts to their own rows.

An activation check follows call chains and triggers, not single functions.
Helpers that branch by core (`native_tool_locked_run`, lease validation, the
wake pin trigger, the materializer loop) are compared branch by branch: the
`snapshot-v1` branch against today's text, the `folder-v2` branch against the
rules here. The check refuses any `folder-v2` path that:
- takes locks out of the order operation key, job, fence, principals and
  indexes, paths, objects, admission, clock (the incident of 27 September was
  a cross-row order problem, 20260927150000:4-9, and "job before fence",
  :33-37, becomes enforced);
- locks the profile row exclusively;
- strengthens a lock on a row it already holds, in any mode; or
- ends a lease without `FOR UPDATE`.

**Stop, in two phases.** Stop first commits the pause, and effects read the
pause before they lock, so new ones refuse without queueing. Stop then takes
the fence row `FOR UPDATE`, which waits out the effects in flight, and bumps
the revision.

**This is a broad lock-order change.** The incident notes of 27 September warn
against exactly that (20260927150000:1-37, 20260927130000). So:
- it applies only to `folder-v2` companies;
- `snapshot-v1` keeps today's exact lock text, verified by activation checks;
- the new paths ship behind activation checks that verify their lock text
  (as 20260927162900:89-110 does); and
- it is load-tested before any company uses it.

**The load test.** It replaces `scripts/load-company-file-fence.mjs` (removed in
C1c-3i), which ran on tmpfs, drove one sequential agent and excused 55P03. It must:
- run on a real disk;
- drive 32 to 64 concurrent runs mixing change sets, reads, listings, stop,
  wakes, ACL narrowing, subtree deletes, the post-commit worker and GC;
- count deadlocks, lock waits and multixact use (`pg_stat_slru`);
- check for authority leaks, missing parents and lost bytes; and
- measure stop latency and admission skips; and
- time a re-resolution over a run that read 25,000 paths, which must fit
  inside the 4-second result fence.

It passes only with no deadlocks, no leaks or losses, and tool-call waits well
under the 4-second result fence (`cloud-native-result-fence.ts`).

**As built (C1e, P24):** `scripts/load-folder-core.mjs` and `.sql`, a new
script rather than an extension of the snapshot-era one. It covers everything
above on 648's fixture, except three things. The post-commit worker is not
built yet (C2's queue). A message's wake stays queued until C4's
materializer, so on `folder-v2` admission is only the admission row's count.
Machine admission is not driven. `--probe-only --big-paths N` times one run
whose read set holds N paths, alone, with function statistics. Its first
finding was the quadratic read-set re-check, fixed by P24b (C1B "Notes for
later slices"). Its second was the upload's presence check, which under a plan
that scanned the company's catalog first checked every object it stores, fixed
by P24c (C1D §7). A third, from P17's review rather than the load: a file
reference's byte check hashed the company's catalog for every file and copied
the commit's locked array for every file or object, so a new folder of 10,000
new files took 87 s; P24d (C1D §4) makes it 4.6-5.9 s, and a copy of it 2.9 s
rather than 17 s. The script reports statements running over 2 s with their wait
events, statements over 1 s with their plans (auto_explain), and PL/pgSQL
functions by self time over the load. Since C1c-3i every migration change runs it short (run-on-node's
`folder-core-load` step: 16 runs for 30 s and a 5,000-path read set), in place
of the snapshot-era pool load.

## 10. What goes, and when

Because of the clean reset, nothing is migrated. `snapshot-v1` companies use
the old code until the reset, so it is removed in C6:

- **Company File columns:** the head, the path-index snapshot and the
  canonical workspace columns on `qorpera_company_files`.
- **Old tables:**
  - today's `qorpera_company_path_entries` and path revisions;
  - company snapshots, publications and the tree cache;
  - workspaces, company-root graphs and restore proofs, and substrate
    snapshot pins.
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
  (`qorpera_enforce_company_storage_quota`), which stays and serves both
  cores until C6.
- **The old organization paths** `organization/agents|rooms|projects/*.json`
  and `organization/formation.json`, with their projectors.
- **The dual-mode scaffolding:** the core flag, the actor's branch, the
  `folder-v2` guards on shared tables, and the refusals in old writers.

Some things are rewritten earlier, because the reset or the proof company
needs them:
- **By C4:** the observability functions on revisions
  (20260828019970:244,367), so the proof company is visible. Done in P32
  (20260930032000): they read the folder core's commits, reviews and read sets.
- **By C5:**
  - the Company File acceptance gates that launch item 19 names;
  - the SQL tests in `scripts/test-*.mjs` that use snapshots;
  - the rollout templates pinned to Company41's head
    (`scripts/runtime-rollout/templates/sql-packet.mjs:10-13`,
    `rehearse-wrapper.mjs:85-90`), which break at the first cut after the
    reset; and
  - the activation-template guards on functions this design changes
    (`scripts/generate-cloud-runtime-bundle.mjs:169`).

## 11. Build plan

Every PR rides the release train and gets an independent review. Every new
function and code path runs only for `folder-v2` companies (§1).

### C1. The core

- The flag, the folder core's tables, and the `folder-v2` source columns and
  guards on the shared tables.
- The change-set commit with the lock rules of §3 and §9, the folder fence,
  the admission row, and the activation checks.
- The actor's `folder-v2` branch, and the per-caller decisions: unchanged,
  branches, refuses.
- Reads without the company lock.
- Authority revisions, read sets by covering resource and grant, read
  records, explicit resources and bases, and read provenance.
- Review classification in SQL.
- GC for `folder-v2` (G1–G4), and today's GC skipping `folder-v2`.
- Tests:
  - SQL tests for every unit and outcome, and for every old writer refusing
    `folder-v2`;
  - concurrency tests: disjoint writes, same-path conflicts, absent-target
    claims, subtree moves and deletes with `asOfSeq`, move against subtree
    delete, fence and two-phase stop, admission, lease renewal and
    lease-ending changes, ACL narrowing against sends, a release racing a
    re-resolution, and the post-commit worker against archive;
  - GC race tests.

C1 ships as slices (agreed 2026-09-28 with the structured-files session F2
and the machine-side session F3, on #408):

| Slice | Contents | Owner |
| --- | --- | --- |
| C1a | the flag; the tables; the change-set commit for members and the platform; reads and listings (with each entry's version time); today's object and artifact GC skipping `folder-v2` | storage core (F1) |
| C1f | `qorpera_folder_feed` (the paths each change set touched, filtered by read authority, with `asOfSeq`) and the clock polled by service_role, so the read-only mount can follow changes before C4 | F3, reviewed by the storage core |
| C1b | run actors (job, lease, fence, causal wake, session kind, requester), computer holders (the company-wide view plus the holder's own authority) and coding sessions (agent ∩ member, `agents/**` and `rules/**` read-only); authority revisions; read sets and records; explicit resources and bases; review classification in SQL; the call sites and inert stubs of the §5 hook that F2 fills | storage core (F1); C1b-3b moved to F3 (below) |
| C1c | the actor's `folder-v2` branch and the per-caller decisions; the raw `/v1/profile-objects` fallback refusing `folder-v2`; the activation checks | F1 through 3c; from 3d, the owners below |
| C1d | GC G1–G4; upload intents; the object gateway's put and remove; a `folder-v2` byte check that never locks the profile row; the storage usage row and the quota trigger | F2 (coordinator, 29 September) |
| C1e | the load test of §9 on a real disk | S3, reviewed by F2 and F3 |

**Owners from 2 October 2026** (the coordinator's plan). The sessions are
named as in the bundle registry: F1 the storage core, F2 structured files, F3
the folder on every machine, Q1 event intake, A1 company accounts, S3
identical nodes, and the Interfaces session.
- **C1b-3b** (computer shell commands and test machines) is F3's, in the
  mount's build steps 4 and 6 (RUNTIME-COMPANY-FOLDER.md, "Build order"):
  light threads gives each shell command on the company machine its own
  mount (2 October amendment "light threads", item 6). It is off the C5
  path.
- **C1c from 3d:** Q1 (joins and the founding lobby on the fence; the
  dynamic-routine tick), A1 (the vault's lock order; offices, screens and the
  agent starting the computer), S3 (the compute fence; deletion; coding
  machines) and F3 (the activation checks).
- **C1d-2b and C1d-2c** (the gateway's GC lane, the worker's folder phase,
  bytes with no catalog row, a deleted company's leftovers) were F2's; from
  3 October 2026 they, and erasure (C2), are the folder GC session's
  (slices P11, P12 and P18).
- **C5 early** (C1D, "C5 early"): F3 moves the SQL test fixtures to version-2
  staging and makes `qorpera_verify_company_path_file` refuse `folder-v2`. F3
  also makes the read actor refuse a company being deleted for members and
  the platform too (runs are refused already).
- **C2:** F2, with the Interfaces session for the interface and table kinds.
  F3 builds conflict copies on receipts, with their GC root.
- **C3:** F3 (the Company File tools), F2 (memory, skills, worker files), A1
  (the vault writes connection files) and S3 (the runner broker's substrate
  model for `folder-v2`).
- **C4:** Q1 (`companySeq`, the listener, the edge functions, the
  observability views), F3 (the member routes and the hint), S3 (the tolerant
  orchestrator), the Interfaces session (the web file page, history and
  editors) and F2 (human-task wakes, H2c).
- **C5:** S3 (the rewrites of §10, the reset function), F3 (the folder service
  #647 and #656 merged and deployed, and the core acceptance script), the
  coordinator (the proof company and the acceptance, including registering the
  proof company's Company Computer: P38 calls `qorpera_register_runtime_office`
  as its owner, the folder mode of C1c-3j, decided 3 October 2026) and the
  coordinator with the Interfaces session (the switch).

Before any `folder-v2` company exists, these must be fixed: #581's N1 (a join
holds the fence before the invitee check), the read actor refusing a company
being deleted, F1's six follow-ups on #613, and the vault's lock order on
`folder-v2` (#660's follow-up: grants and secrets against Disconnect and
share, and capture, rotation and seal against a member change).

Two things stay with Jonas: the reset's scope (C5 step 4), and the artifact GC
worker's key, a secret he creates (RUNTIME-COMPANY-DELETE.md, "Switching the
worker on"). Nothing else in this plan waits on him.

### C2. Structured files, seeding and erasure

- The hook of §5: schemas, indexes, the refusals and the converging queue.
  - The hook includes the interface and table kinds (`interface.toml`,
    `order.md`, `table.toml`, `rows.csv`; 2 October amendment "interfaces",
    item 12, built as step I6).
  - The queue takes over a hire's default grants (read and write since
    20260926035000): `qorpera_ensure_default_agent_read_grants` inserts them
    outside the authority journal today.
- Company creation as one commit with the first-run wake. The seed includes
  `human-tasks/` and `contacts/` (2 October amendment "work for people", item
  5) and `interfaces/` and `tables/` with the library copies (2 October
  amendment "interfaces", item 11).
- Proposals for parked units and the restricted hire.
  - R1 (#613) records the review of tool calls. The restricted hire is a card
    on that record (W4a, #621), not a parked proposal.
  - R2 reviews change sets that no tool call carried, and adds
    `qorpera_folder_proposals`. Until it exists, agents make the interface
    and table changes that "interfaces" item 7 counts as delegation only with
    `save_interface`, which joins R1's tools.
- Erasure. "Work for people" item 3 (approved 3 October 2026) widens it from
  a deleted agent's folder to any deleted path (a contact's file too).

### C3. Runtime and writers

For `folder-v2` companies:
- The Company File tools work through the folder core.
  - `company_list`, `company_read` and `company_search` act with the run's own
    folder view. Each answer is released against the exact text the model is
    shown, and search runs on the node's folder service (2 October amendment
    "light threads", item 2).
  - A turn writes with the one-file tools through the mutation gateway (the
    same item). On `folder-v2` each such write commits as a change set of one
    unit (§3).
  - These tools stay for turns (decided 3 October 2026, "light threads" item
    2). Changes of several files, and changes a command makes, come from a
    machine's change set.
  - Built in slice P19 (`packages/runtime/src/cloud-folder-file-tools.ts`):
    each read or listing is fitted to one tool result before its release, and
    `company_delete` records the automatic review's approval of its call (C2
    R1) and deletes a file or an empty folder.
- The memory, skills, todo, routine and hiring writers write files. Memory
  and skills: slice P20 (`packages/runtime/src/cloud-folder-notebooks.ts`)
  runs the same composition and tools over a folder-v2 form of the trusted
  gateway. Each tool call releases its reads under its answer; composition's
  reads are released once under the composed context, before the first model
  request. A skill deletion in the agent's own library records its review
  as `company_delete`'s does (`20260930001200`). The
  platform writes a worker's brief and results at dispatch, follow-up, report
  and decision (F2-5b).
- The vault writes connection files: it marks a file due, and the object
  gateway's writer commits it as the platform (P22a marks and claims, P22b
  the writer, P22c website accounts).
- The tools the layout amendment retires are removed from the model's tool
  list, or become thin writers of the same files.

### C4. Journal consumers and clients

- The wake drain works on sequence numbers, and the pin becomes `companySeq`.
  The `folder-v2` materializer (P28) also calls F2's worker drain,
  `qorpera_folder_drain_worker_wakes(environment, limit)`, for each company
  that `qorpera_folder_worker_wakes_due()` lists, in its own transaction,
  before it materializes that company's wakes (RUNTIME-COMPANY-STATE-FILES.md,
  "Plan (F2-5b)" §6). Its acceptance includes "a dispatch runs and its revival
  returns".
- The members' and clients' hint (the feed itself is C1f).
- The observability views (P32, migration `20260930032000`: the operator's run and company queries read commits,
  reviews and read sets).
- The web client's file page, history view and editors (rules, sections,
  agent details, routines, group chats) branch on the core flag, and write
  and read files for `folder-v2`. No member writer of `folder-v2` files goes
  live before human-task wakes (H2c) run on the listener
  (RUNTIME-COMPANY-STATE-FILES.md, "What H2b without H2c means").
- Tolerant readers and writers go out first:
  - the runner orchestrator accepts runs without snapshot or substrate ids
    (`parseRunnerWork` and `validateCloudRunnerWork` in `orchestrator.ts`; done in #709);
  - the object gateway serves `folder-v2` without tree manifests
    (`member-company-file.ts:794`, `company-bootstrap.ts:252`);
  - the edge functions handle `folder-v2` (runner-broker's verifier call
    `index.ts:348`, runner-control's `outputSnapshotId` `runner-control.ts:155`,
    member-company-gateway's snapshot route);
  - the object gateway's connection-file writer, switched on by its flag
    (amended 3 October 2026, P22: the secret broker gets no folder access).

### C5. Proof, reset and switch

1. The rewrites of §10 due by C5 land.
2. An operator creates one `folder-v2` proof company and runs the core
   acceptance below. The load test of §9 passes.
3. The reset procedure is written as a service-role function, and becomes the
   product's "Delete company" for `folder-v2` companies (founder decision,
   28 September 2026). It reuses company delete D1–D6
   (RUNTIME-COMPANY-DELETE.md), which already deletes a company that has had
   runs: the request, the finisher and the purge. `folder-v2` adds:
   - the deletion drain on the folder fence (C1c-3g) and the folder rows in
     the purge;
   - a deleted company's leftover bytes (C1d-2c), which the artifact GC
     worker removes once it is deployed.
4. Its exact scope goes to the founder for confirmation, including whether the
   proof company is deleted too.
5. One owner runs it in a short maintenance pause, and company creation
   switches to `folder-v2` by default.

**Core acceptance (C5).** On a new company:
- the seeded tree exists, and creation wrote exactly one kickoff and its
  turn request; the first-run wake once P28 materializes it;
- agents read, list, search and write through change sets, and disjoint
  writes never conflict (search is `company_search` on the node's folder
  service, "light threads" item 2, so the folder service is live before the
  proof);
- a same-path conflict keeps a conflict copy;
- a move and a subtree delete work, and a subtree delete refuses a change it
  did not see (through the member route or a machine: a turn's tools write
  one file at a time);
- hiring, archiving, a routine file, a group chat and sections each update
  their index, and pass or skip review as 5.6 says;
- a coding session cannot write `agents/`, and is never reviewed;
- a file change wakes a listener exactly once;
- the web file page and history show the change;
- revocation of one agent's grant stops that agent's send and no other;
- stop takes effect under load;
- GC races lose nothing;
- erasure removes a deleted agent's history; and
- the launch items of the layout amendment that do not need the mount pass:
  3, 4, 5, 11, 15, 17, 19 and 21.

Items 6, 13 and 14 need the mount and the Company Computer, and are proven in
the mount steps.

### C6. Removal

Once no `snapshot-v1` company remains, everything in §10 goes.

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
3. **Member-private folders.** Decided 3 October 2026 (the coordinator, at
   Jonas's request): `folder-v2` has no `members/` folder. The company comes
   first (Jonas, 24 September 2026): a member's personal settings stay in the
   database, and the implicit `members/<id>/private` rule is not carried into
   `folder-v2`. The `folder-v2` resolver and its key and grant checks (C1a,
   C1b) still keep a path under `members/<id>/private` from everyone but the
   platform, and nothing on `folder-v2` creates a member's private resource.
4. **"Delete company" in the product.** Decided by the founder on
   28 September 2026: the C5 reset procedure becomes the product's delete for
   `folder-v2` companies. The old `qorpera_delete_hosted_profile`
   (`web/src/cloud/api.ts:256`) failed for any company that had had a run;
   company delete D1–D6 (RUNTIME-COMPANY-DELETE.md) now works after runs, and
   the reset reuses it (C5, step 3).
