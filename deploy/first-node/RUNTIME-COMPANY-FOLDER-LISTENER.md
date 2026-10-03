# Company folder core: file-change wakes (slice P29)

Status: design, for review. Owner: the folder GC and erasure session (P29 moved from Q1 on 4 October 2026). Rules:
core §6 "Wakes" and §9 ("a file change wakes a listener exactly once"), WAKE-BUS.md (today's listener contract),
STATE-FILES.md §8 "Plan (H2)" item 9 (H2c builds on this). Builds on P28 (#756, the folder-v2 materializer).
Evidence: `~/work/qorpera-folder-core-tools/reports/P29-inventory.md`. Q1 and F2 answered the questions on the
materializer's wake format, the lock order and the drain's placement.

## 1. What P29 is

A routine file whose trigger is `when: file-change` (with `watch` and `match`) wakes its agent when a saved change
touches the watched path. On folder-v2 nothing does this today:
- the routine rules refuse a file-change routine ("waits for the folder's file events");
- six places refuse or break a file wake (§7);
- after P28, reconcile no longer runs the old snapshot-v1 drain, so file wakes run on no core at all.

P29 brings them back on folder-v2, read from the folder journal.

It also opens the commit stream to H2c (P31, human-task wakes; §8). It does not cover:
- a worker's results (F2-5b-3's worker drain makes that wake from the worker row, not from a file change, so the
  listener must not wake a parent for a worker's report);
- overdue human tasks (H2c's own timed scan);
- event, office and machine wakes.

## 2. Listeners

**A listener is a folder-v2 routine,** with no table of its own:
- its row has `folder_path` set and status `active`;
- its current version's trigger is a file-change trigger.

**The trigger:**
- `qorpera_company_state_routine_trigger` returns `{kind: 'file-change', watch, match, timeZone}`. `watch` is the
  folded key of the watched path; `match` is `exact` or `subtree`.
- The trigger keeps today's `id: 'file'` and `replyPolicy`.
- The routine rules stop refusing it.
- At save, the rules check what the old listener checked: the routine's agent, with its requester, may read the watched
  path (`qorpera_folder_actor_allowed`, read). Otherwise the save is refused, naming the path.

**Activation, future-only:** a listener sees the changes with seq greater than its **activation seq**. The activation seq
is the seq of the commit that last wrote the routine row (`folder_commit_id`):
- a new routine or a new version listens from the change set that saved it, so that change never wakes it;
- a resume, which is a save, starts again from the resume;
- a change the drain had not reached when the routine was edited is not delivered to the edited routine, as today's
  version cursor drops it (WAKE-BUS.md).

No activation trigger runs inside the commit:
- today's `qorpera_cloud_routine_listener_activation` and `_status` take the gc fence and read a snapshot head, and
  would break in a folder-v2 commit;
- both get a folder-v2 early return, keyed on the routine's `folder_path`.

## 3. The cursor

One cursor per environment: `qorpera_folder_listener_cursors(environment_id → folder clock cascade, processed_seq,
updated_at)`. Every seq up to `processed_seq` is done for every listener. Per-listener cursors would cost a row and a
lock per routine, and the activation seq already gives each listener its start.

**Where a new cursor starts:** at the smallest activation seq among the environment's active listeners (or the clock's
`last_seq` when there is none), so no change after a listener's activation is missed.

**The drain's lease:** the drain takes the cursor row `FOR UPDATE SKIP LOCKED` as its first lock.
- Only the drain locks that row; nothing in core §3 waits on it.
- So two drains of one company never overlap, and a commit never waits on a drain's lease.

## 4. The drain

`qorpera_folder_listen_company(p_environment_id uuid, p_limit integer default 64) returns jsonb` works on one company,
in its own transaction. It is service_role only, like the materializer's RPCs. It never runs inside
`qorpera_folder_materialize_company`, whose admission would then come before its own ranks (Q1, F2).

1. **The lease:** the cursor row `FOR UPDATE SKIP LOCKED`; a held cursor answers `busy`.
2. **Plain reads.**
   - The journal's `change_set` rows with seq in `(processed_seq, processed_seq + p_limit]`, up to the clock's
     `last_seq`. Authority rows are passed over and count as done.
   - The active listeners.
   - For each listener and each commit after its activation seq, the matched path versions, at most 21 (§5).
3. **Ranks:** `qorpera_folder_company_enter(env, profile, targets, refuse_paused => false)`. The targets are each matched
   routine's requester (rank 1), its agent (rank 2) and the agent's execution authority (rank 3), all KEY SHARE; the
   routine FOR NO KEY UPDATE (rank 5); and the hook's targets (§8). This is the materializer's and routine firing's
   prefix (fence KEY SHARE, rank 0, ranks 1 to 5).
4. **Re-checks under the locks:**
   - each matched routine is still active;
   - its current version is the matched one;
   - its activation seq is below the change's seq.
   A routine that fails is passed over for those changes.
5. **Sessions:** each matched routine's public session KEY SHARE (`qorpera_folder_wake_public_session`), as routine
   firing takes it before admission.
6. **Admission:** `qorpera_folder_admit_wakes(profile)`.
7. **Wakes:** one insert per (change, routine), with `on conflict (routine_id, occurrence_key) do nothing`.
8. **The hook:** `qorpera_folder_listener_commit(env, commit)` for each change set, in seq order (§8).
9. **The cursor:** `processed_seq` moves to the last seq read.

**Paused company:** the drain still runs. The pin trigger inserts a paused company's routine wakes as `cancelled`, as it
does today, and the cursor moves on, so a resume does not replay a pause's worth of changes.

**Bounds:**
- at most `p_limit` seqs a step;
- at most 21 matched versions per (listener, change), read through an index (below);
- at most 32 listeners matched per step. The rest wait for the next step, and the cursor stops before the first seq
  left unfinished.

## 5. Matching

**What matches:** a change set matches a listener when one of its saved path versions lies at the watched key (`exact`)
or at or under it (`subtree`, the range written out as P18's searches do):
- **moves:** a move writes a `move_out` at each source path and a `move_in` at each target, one per descendant, so a
  move from or into the watch matches, and so does moving an ancestor of an `exact` watch;
- **copies:** a copy matches at its target only; its source does not change;
- **refused units:** they write no version and never match;
- **erasure:** an erased change has no versions and never matches.

**The search:** `qorpera_folder_path_versions` by `(environment_id, folded key)` (P18a's index) with `commit_id` the
change's, or by `(commit_id, unit_no, version)` for a large change set: the planner chooses. Either way the read is
bounded.

**Who is woken:**
- **The self rule:** a change set never wakes the agent that made it. Ancestry comes from the commit:
  `qorpera_wake_ancestry(commit.run_id, the commit's staff actor, recipient, commit.id)`. Null means the recipient is
  already in the chain (or the chain has 16 agents), and there is no wake.
- **A detached view's commit** (a coding session or a desktop, staff actor, no run) is the actor's own, so its agent is
  never woken by it.
- **The member's and platform's commits** wake normally.

**What the agent may read:** a matched path counts only if the routine's agent, with its requester, may read it. If none
of a change's matched paths may be read, there is no wake. The listener never reveals that an unreadable path changed,
as the feed leaves such a change out.

## 6. The wake

| Column | Value |
| --- | --- |
| `wake_kind` | `routine` |
| `routine_id`, `routine_version` | the listener's |
| `source_kind` | `company-file` |
| `source_id` | the commit's id |
| `trigger_id` | `file` |
| `occurrence_key` | `file:<seq>:<routine_version>` (unique with the routine: the wake is the claim, keyed by company, seq and trigger) |
| `scheduled_for`, `not_before` | now; the lifecycle trigger may defer it for quiet hours |
| `payload` | `{schema: 'qorpera.folder-file-wake/v1', seq, commitId, changes: [{path, op, version, priorVersion?, from?}], more}`, at most 20 changes, at most 8192 bytes; `more` is true when trimmed |

The pin trigger fills in the staff, requester, sponsor and session from the routine version, as it does for a schedule
wake. The run's `company_seq` (P28) is the clock read at materialization, never below the change's seq, so the run is
composed as of at least this change, as core §6 asks.

## 7. The six places that refuse or break a file wake today

1. **`qorpera_folder_wake_authorized`** refuses `company-file`. Its folder-v2 branch gains company-file:
   - the source commit exists in the wake's environment;
   - the routine is active and current;
   - ancestry recomputed from the commit (as §5) equals the stored root and agents, so the materializer's comparison
     holds, including for a detached view's commit;
   - the session rule is as for a routine wake.
2. **`qorpera_folder_run_resolve`** refuses company-file runs (0A000). It accepts them, as it does schedule wakes.
3. **The pin trigger's company-file branch** reads a snapshot-v1 path revision (`file_event_id`). A folder-v2 branch
   takes the parent run and actor from the commit named by `source_id`, and leaves `file_event_id` null.
4. **`qorpera_runtime_wake_policy_internal`** falls back to the closed policy unless `source_id` equals `file_event_id`.
   A folder-v2 branch keys on `source_id` = the commit.
5. **The runtime's company-file payload** is closed to the snapshot-v1 shape. P29b (runtime, rides the bundle) accepts
   `qorpera.folder-file-wake/v1` with `source.id` = `commitId`. It must be live in the same release as P29a's SQL, as
   P28b is for `companySeq`.
6. **The routine rules and trigger** (§2).

## 8. The hook for H2c (P31)

H2c needs every landed change set in seq order, inside the transaction that admits its wakes (F2). It also needs its
lock targets taken at their ranks before admission. P29 ships two functions with no-op bodies, which P31 replaces
(`create or replace`, its own body marker):
- **`qorpera_folder_listener_targets(env, commits jsonb) returns jsonb`** gives lock targets for `company_enter`. It is
  called once a step, before the ranks (step 3).
- **`qorpera_folder_listener_commit(env, commit jsonb) returns void`** is called once per change set, after admission
  (step 8).
  - `commit` is `{commitId, seq, actor: {kind, id}, runId, units: [{unit, op, path, from?, version, priorVersion}]}`,
    read from the path versions.
  - It runs in a subtransaction. A failure is caught and the change set counted as done, never failing the step: H2c
    keeps its own markers and dedupes, so at-least-once is fine (F2).
  - The `human-tasks/*.md` pre-filter is H2c's.

## 9. Scheduling

**The due list:** `qorpera_folder_listen_due(p_after_environment uuid default null, p_limit integer default 100)` returns
the environments whose clock is ahead of their cursor (an absent cursor counts as behind when a listener is active).
It is a plain read, through the clock and the cursor.

**The orchestrator:** `CloudFolderRunMaterializer` runs the listen step before it lists the materializer's due
companies, one company per request, through new edge actions `folder_listen_due` and `folder_listen_company`. The wakes
a step inserts are then materialized in the same pass. Commits don't nudge the orchestrator, so a file wake waits at
most one 2 s poll.

## 10. Erasure

A file wake's payload holds paths, so P18's erasure scrubs it, as ERASURE.md §5 says the listener's wakes must ("join
before they hold paths"). In phase 2, the drain also walks the environment's company-file wakes made before a root's
cutoff time (by `created_at`, with a cursor and the step's budget). Each matched change's `path` and `from` become
`""`, keeping the payload's shape. This is P29's change to erasure.

## 11. The split

- **P29a** (migration 20260930020000; SQL tests 887 for the listener, drain, refusals, hook and erasure, and 888 for
  races):
  - the cursor table and the drain, due and hook functions;
  - the six fixes of §7, except the runtime one;
  - the routine rules and trigger;
  - the activation and status early returns;
  - erasure's wake scrub;
  - the orchestrator step and edge actions.
- **P29b** (runtime): the `qorpera.folder-file-wake/v1` payload in the wake envelope parser. It goes out with P29a in the
  same release.

## 12. Tests

887:
- a write, a delete, a move from and into the watch, an ancestor's move and a copy, each waking once with its changes;
- `exact` against `subtree`;
- a refused unit never wakes;
- the self rule, including a detached view's commit;
- an unreadable path is never revealed;
- activation: no wake for the saving change set, and a resume starts from the resume;
- the materializer runs the wake (with P28 merged);
- a paused company's wakes are cancelled and the cursor moves on;
- the 20-change and 8192-byte bounds;
- the hook's order and the arguments it receives;
- erasure scrubs a file wake's paths;
- the refusals of §7 are gone.

888 (dblink):
- two drains of one company: the second answers `busy`;
- a drain against a commit that edits the routine, and against routine firing;
- the drain against the materializer;
- lock order: no wait from a commit on a drain's lease.

## 13. For the coordinator

1. One cursor per environment with activation seqs on the routines (§2, §3), not per-listener cursors.
2. Activation is future-only from the saving commit; an edit drops changes not yet drained (as today).
3. A paused company's file wakes are recorded cancelled and not replayed (as today).
4. Unreadable paths: no wake, and never named (§5).
5. The payload is bounded to 20 changes and 8 KiB, with `more`, and erasure scrubs it (§6, §10).
6. H2c's hook: two no-op functions P31 replaces, and a hook failure never fails the step (§8).
7. The split: P29a SQL and orchestrator, P29b runtime, in one release (§11).
