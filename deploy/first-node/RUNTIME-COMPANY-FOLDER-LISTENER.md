# Company folder core: file-change wakes (slice P29)

Status: built (P29a and P29b in one PR, branch `fable/folder-listener-p29a`; what is built and tested is §15). The
design was decided in §14: review r3 APPROVE at 1e03c01ff (`~/work/qorpera-folder-core-tools/reports/P29-design-review-r1.md`)
and the coordinator's decisions of 4 October 2026. Owner: the folder GC and erasure session (P29 moved from Q1 on
4 October). §9 is the shared folder-drains step that other per-company drains plug into.

Rules:
- core §6 "Wakes" and §9 ("a file change wakes a listener exactly once");
- WAKE-BUS.md (today's listener contract: activation, causality, denied claims, read rechecks);
- STATE-FILES.md §8 "Plan (H2)" item 9 (H2c builds on this).

Builds on P28 (#756, the folder-v2 materializer). Evidence: `~/work/qorpera-folder-core-tools/reports/P29-inventory.md`.
Q1 (P28) and F2 (F2-5b, H2c) reviewed the drain's placement, the wake format and the hook.

## 1. What P29 is

A routine file whose trigger is `when: file-change` (with `watch` and `match`) wakes its agent when a saved change
touches the watched path. On folder-v2 nothing does this today:
- the routine rules refuse a file-change routine;
- the places in §7 refuse or break a file wake;
- after P28, reconcile no longer runs the old snapshot-v1 drain, so file wakes run on no core at all.

P29 brings them back on folder-v2, read from the folder journal.

It also offers every change set to H2c (P31, human-task wakes; §8). It does not cover:
- a worker's results: F2-5b-3's worker drain wakes the parent from the worker row. A worker's `report_work` commits as
  the worker's run, so the self rule (§5) keeps the listener from waking the parent's own subscription;
- overdue human tasks (H2c's own timed scan);
- event, office and machine wakes.

## 2. Listeners

**A listener is a folder-v2 routine,** with no table of its own:
- its row has `folder_path` set and status `active`;
- its current version's trigger is a file-change trigger.

**The trigger:**
- `qorpera_company_state_routine_trigger` returns `{kind: 'file-change', id: 'file', watch, match, timeZone,
  replyPolicy}`. `watch` is the folded key of the watched path; `match` is `exact` or `subtree`.
- `qorpera_cloud_routine_trigger_valid` accepts that kind (§7).
- The routine rules stop refusing it, and at save they refuse:
  - a watched path the routine's agent, with its requester, may not read (`qorpera_folder_actor_allowed`, read), as the
    old listener checked;
  - a payer that is a ChatGPT plan: a plan pays only for work its member starts (20260928359950; §7).

**Activation, future-only:** a listener sees the changes whose seq is greater than its **activation seq**. The
activation seq is the seq of the commit that last wrote the routine row (`folder_commit_id`). This matches today's
version cursors, with one difference: any save of the routine file moves it, including a quiet-hours edit or a save
that changes nothing, where today only a new version or a resume does.
- A new routine or version listens from the change set that saved it, so that change never wakes it.
- A resume, which is a save, starts again.
- A change the drain had not reached when the routine was edited is not delivered (decision 2). STATE-FILES.md's routine
  section says so for agents (P29a updates it).
- A routine whose activation seq cannot be read is no listener; the compare is NULL-safe.
- A routine whose stored trigger no longer passes `qorpera_cloud_routine_trigger_valid` is no listener either (review
  r1 F3): the pin trigger would refuse its every wake, and that would hold the company's cursor for good. (A watch is a
  fixed point of `qorpera_folder_key`, whose case mapping follows PostgreSQL's Unicode tables; a time zone can leave the
  known list.)

**The old triggers:** today's `qorpera_cloud_routine_listener_activation` and `_status` act only on the legacy kind
`listener` and on legacy cursor rows, so they do nothing for `file-change`. They stay as they are.

## 3. The cursor

One cursor per environment: `qorpera_folder_listener_cursors(environment_id → folder clock cascade, processed_seq,
updated_at)`, with RLS on and revoked from every role. Every seq up to `processed_seq` is done for every listener and
for the hook.

**Creation:** the drain creates the row lazily, after the fence (§4 step 3), never before it, at 0: activation already
keeps every listener future-only, and the hook (§8) is offered every change set from the start.

**The lease:** the cursor row, `FOR UPDATE SKIP LOCKED`, taken after the ranks, as a run-owned row.
- Only the drain locks it. Commits, routine firing, the materializer and erasure never touch it.
- The company purge deletes it by cascade, after the fence the drain takes first (KEY SHARE). So the two meet at the
  fence and never in a cycle; a lease taken before the fence would deadlock with the purge's cascade.

## 4. The drain

`qorpera_folder_listen_company(p_environment_id uuid, p_limit integer default 32) returns jsonb` works on one company,
in its own transaction. It is service_role only. It never runs inside `qorpera_folder_materialize_company`, whose
admission would then come before its own ranks (Q1, F2).

Settings: `lock_timeout = '2s'`. A lock timeout (55P03), a deadlock, or a conversation that moved under an insert
(step 9) undoes the whole step and answers `busy`; the next pass tries again.

The cursor row's foreign key takes the folder clock row KEY SHARE when the row is first made (and a failure row's after
admission), before core §3's "clock last". It never waits: commits take the clock FOR NO KEY UPDATE, and only the purge
deletes it, after taking the fence FOR UPDATE, which the drain already holds KEY SHARE (review r1 F8).

A step that always raises (any error but a lock timeout, a deadlock or QP29S) never commits, so the company's cursor
stays before that seq and its later file wakes and hook calls wait behind it; the orchestrator backs that company off
up to 5 minutes and keeps trying, and its failures show in the pass's errors. The known causes are guarded: an invalid
trigger is no listener (§2), and the targets hook cannot raise into the step (§8).

The answer: `{schema: 'qorpera.folder-listen/v1', state, processedSeq, wakes, skipped, inactive, hookFailures, more}`,
where `state` is `done`, `idle` (nothing new and no recorded failure due), `paused`, `busy`, `deleting` or
`not_folder`.

1. **The role check,** before anything is read or locked.
2. **Plain reads,** bounded:
   - the journal's `change_set` rows with seq in `(processed_seq, processed_seq + p_limit]` (authority rows are passed
     over and count as done);
   - the active listeners;
   - for each listener and each commit after its activation seq, up to 21 matched readable path versions, through the
     new index `(commit_id, (qorpera_folder_key(path)) collate "C")` with the key range written out (§5);
   - the hook's targets (§8).
3. **Ranks:** `qorpera_folder_company_enter(env, profile, targets, p_refuse_paused => false)`: the fence KEY SHARE,
   rank 0, then each matched routine's requester (rank 1), its agent (rank 2) and the agent's execution authority
   (rank 3), all KEY SHARE, the routine FOR NO KEY UPDATE (rank 5), and the hook's targets. This is routine firing's
   and the materializer's prefix.
   - A company being deleted answers `deleting`.
   - The cursor row is created here if it is absent.
4. **The lease:** the cursor row `FOR UPDATE SKIP LOCKED` (§3). A held cursor answers `busy`. A `processed_seq` that
   moved since the plain read answers `busy` too, and the next tick reads again.
5. **A paused company:** the cursor moves past the window, no wake is written, and the hook is told the company is
   paused (§8). A cancelled wake row per change would count toward a routine's `runs` limit and could expire it
   (decision 3, amended).
6. **Checks under the locks.** Each (change, listener) match is checked against everything the wake triggers check, so
   an insert does not raise:
   - the routine is still active, its current version is the matched one, and its activation seq is below the seq;
   - it has not expired by the wake's `scheduled_for`;
   - it is below its occurrence limit, counting this step's own inserts;
   - the requester is a member and the agent is active;
   - a `required` reply has a public session;
   - the causal chain is not fenced (§5).

   A failed check is final, as today's denied claim is. Nothing is written, and the step's answer counts it. The step
   also probes `(routine_id, occurrence_key)` and inserts nothing for a wake that exists.

   **An archived agent's listener** (an archive its routines have not followed yet) may read nothing, so it could never
   match. The plain read sets it aside before matching, once the window holds a change set after its activation; a
   match whose agent was archived since the read is set aside here too. The answer counts those agents (`inactive`). At
   the end of this step, inside the not-paused branch, P15 (20260930022000) marks each set-aside agent's follow-up, as
   routine firing does (F2; P15 design review r4 N5). P15 patches the comment that marks the place.
7. **Sessions:** each matched routine's public session KEY SHARE (`qorpera_folder_wake_public_session`), and the
   sessions the hook named, as routine firing takes them before admission.
8. **Admission:** `qorpera_folder_admit_wakes(profile)`, only when the step will insert a wake or the hook's targets say
   it will (`admit`, §8).
9. **Wakes:** one insert per match. Each runs in a subtransaction that catches only the known refusals (the lifecycle
   trigger's 'Routine has expired' and occurrence limit, and the pin trigger's recipient, audience and ancestry
   refusals) as a final skip. Any other error fails the step, such as 'Folder wake admission is required', a lock
   timeout or a deadlock (Q1). After each insert, the chosen session is checked as routine firing checks it; a
   mismatch answers `busy`.
10. **The hook:** `qorpera_folder_listener_commit` per change set, in seq order (§8), after the recorded failures are
    tried again.
11. **The cursor:** `processed_seq` moves to the last seq whose work is all done.

**Bounds per step:**
- at most `p_limit` seqs;
- at most 21 matched versions per (listener, change), each found through the commit-and-key index;
- at most 32 new wakes;
- at most 46 subtransactions that write (wake inserts, hook calls and hook retries together), besides the step's own.
  Past 64 in one transaction, PostgreSQL's subtransaction cache overflows, which slows every concurrent reader (core §3
  step 7; Q1). The first wake insert also nudges the orchestrators (`qorpera_wake_runner_orchestrators_internal`: one
  block, and one `realtime.send` block per active orchestrator), so a step uses at most 46 + 2 + N; that stays under 64
  while N ≤ 15 orchestrators are active (review r1 F9). P31's hook budget comes out of the same 46.

What a bound leaves waits for the next step: the cursor stops before the first seq not finished, and that seq's
existing wakes are found by the probe and not counted again. A company with many listeners gets a smaller seq window,
so that listeners × seqs stays within a fixed budget.

## 5. Matching

**What matches:** a change set matches a listener when one of its saved path versions lies at the watched key (`exact`)
or at or under it (`subtree`).
- **Moves:** a move writes a `move_out` at each source path and a `move_in` at each target, one per descendant, so a
  move from or into the watch matches, and so does moving an ancestor of an `exact` watch.
- **Copies:** a copy matches at its target only; its source does not change.
- **Refused and erased units:** they have no versions and never match.

**The read:** the new index `(commit_id, (qorpera_folder_key(path)) collate "C")` serves "this commit's versions under
this watch", whatever the size of the change set or the history under the watch. It is an expression index, so the
table is not rewritten. Without it, one 100,000-entry move would read every row of the commit for each listener.

**What the agent may read:**
- A match counts only if the run that the wake will start may read it. The check uses that run's actor: kind
  `staff_agent`, the routine's agent, its requester, the audience of the routine's public session (or `company` when it
  has none), session kind `in_house`.
- The filter is decided once per covering resource, not per row: a company has few resources, so the step works out
  which resources under the watch the actor may read, and probes only those key ranges. An unreadable 21st match then
  never hides a readable 22nd, and a 100,000-entry private move costs one decision, not 100,000.
- Under `members/`, a member's private folder is ruled by its owner, so that piece is checked path by path, at most
  2048 paths per (listener, change set): a readable path after 2048 unreadable ones there is neither found nor counted
  (review r1 F7).
- No readable match means no wake, and the change is never named or counted (decision 4).
- When the run reads its wake, the check runs again (§6), as WAKE-BUS requires at delivery.

**Who is woken (ancestry from the commit, `qorpera_wake_ancestry(parent, actor, recipient, commit.id)`):**
- **A run's commit:** the parent is the commit's `run_id`. The run's agent is in its own chain, so it is never woken
  by its own change.
- **A coding session's commit during a leased turn:** the parent is the commit's `turn_run_id`, not a fresh root. This
  keeps two agents' coding sessions from waking each other without end, since WAKE-BUS fences unknown provenance rather
  than resetting it. C1B called `turn_run_id` "attribution only"; P29a amends C1B (§14, item 8).
- **A desktop whose run has ended, or a coding save outside any turn:** the parent is null, the actor is the staff
  agent, and the root is the commit.
- **A member's or the platform's commit:** a fresh chain. A platform commit that follows from a run's own act (the
  vault's connection-file writer) also starts fresh; this is a known gap, noted for C4.

A null answer means the recipient is the chain's last agent (so an agent's own change never wakes it) or the parent's
provenance is unknown; both are fenced, never reset. **Nothing else bounds a chain** (review r1 F2): the 16-agent stop
and the repeated-recipient fence were removed on 24 September (`20260924130000_runtime_remove_run_and_machine_caps.sql`,
`20260924160000_runtime_remove_standing_counts.sql`), as for agent messages (#265). So two listeners whose runs write
into each other's watches wake each other, one paid run per hop, until a member presses Stop, a routine's `runs` limit
ends it, or the company is paused; no fence is added for file wakes (§14 item 10). The chain stays visible: the wake
row and the run's envelope name the change set (`source.id`), the run that made it (`parentRunId`) and the chain
(`causal.rootId`, `causal.agentIds`).

## 6. The wake

| Column | Value |
| --- | --- |
| `wake_kind` | `routine` |
| `routine_id`, `routine_version` | the listener's |
| `source_kind` | `company-file` |
| `source_id` | the commit's id (the pin trigger keeps it; §7) |
| `trigger_id` | `file` |
| `occurrence_key` | `file:<seq>:<routine_version>`, unique with the routine: the wake is the claim, keyed by company, seq and trigger |
| `scheduled_for`, `not_before` | the commit's `created_at` and now; the lifecycle trigger may defer `not_before` for quiet hours |
| `payload` | `{schema: 'qorpera.folder-file-wake/v1', seq, commitId, versions: [≤ 21 version ids], more}` |

`more` is the number of readable matches past the first 21, counted up to 1000 as event wakes count theirs;
unreadable ones are never counted.

**No path names in the row.** `qorpera_folder_read_wake` builds the run's payload when the run reads its wake:
`{schema, seq, commitId, changes: [{path, op, version, priorVersion?, from?}], more}`.
- It uses the versions that still exist and that the run's own actor may still read.
- It stops at 8 KiB of changes and counts the rest in `more`, so the read stays below `qorpera_folder_read_wake`'s
  48 KiB limit with the conversation's held messages.
- `from` and `priorVersion` appear only when the source is readable too, as the feed shows a move's prior version.
  The source is found through a partial index on move-outs `(commit_id, prior_version)`, not by scanning a large move.
- The stored `more` was counted under the drain's rights: once one of the stored changes is hidden from the run (a
  grant narrowed since), the stored count is dropped too (review r1 F11). A narrowing or erasure that touches only
  changes past the first 21 is not seen, so `more` can still count a few of those (review r2 N3).
- An erased version has gone, so it drops out by itself. Erasure needs no wake scrub, the wake identity guard stays as
  it is, and no race can leave an erased path in a wake.
- A run that already read its wake is noted by erasure (§10).

**The pin:** the pin trigger fills in the staff, requester, sponsor and session from the routine version. The run's
`company_seq` (P28) is the clock read at materialization, never below the change's seq.

**The envelope:** for a member's commit, `actorUserId` names that member.

## 7. What P29 changes outside its new functions

1. **`qorpera_folder_wake_authorized`** refuses `company-file` today. Its folder-v2 branch gains company-file:
   - the source commit exists in the wake's environment;
   - the routine is active and current;
   - ancestry recomputed from the commit (§5) equals the stored root and agents, so the materializer's comparison holds
     for every kind of commit;
   - the session rule is as for a routine wake;
   - at least one stored version still exists and the run's actor may read it, as WAKE-BUS asks at materialization as
     well as at delivery. Otherwise the wake is cancelled, so a fully erased or unreadable wake never becomes a run;
   - no ChatGPT plan pays: a plan-paid company-file wake is refused, and so is any wake whose parent run follows a
     listener (`qorpera_run_follows_listener`), as the snapshot-v1 branch refuses them (20260928359950:195-204).
2. **`qorpera_folder_run_resolve`** refuses company-file runs (0A000). It accepts them, as it does schedule wakes.
3. **The pin trigger:**
   - its company-file branch requires the legacy kind `listener` and a `file_event_id`, and overwrites `source_id` with
     the routine id;
   - a folder-v2 branch accepts `file-change`, keeps `source_id` (the commit), leaves `file_event_id` null, and takes
     the parent and actor from the commit (§5).
4. **The wake policy** (`qorpera_runtime_wake_policy_internal`) closes a company-file wake unless its kind is `listener`
   and `source_id` equals `file_event_id`. A folder-v2 branch accepts `file-change` with `source_id` = the commit.
   Otherwise every chain from a file-woken run would be fenced.
5. **`qorpera_cloud_routine_trigger_valid`** accepts `file-change`. Without it, the folder rules (the save), the pin
   trigger, the session-less check and the wake policy all refuse the kind.
6. **`qorpera_routine_occurrence_count`** counts distinct `(trigger_id, file_event_id, scheduled_for)`. That would
   count one step's file wakes as one. Company-file wakes count by `occurrence_key`.
7. **The runtime (P29b):**
   - the wake envelope parser accepts `qorpera.folder-file-wake/v1` with `source.id = commitId`;
   - the prompt text ("wake.payload names the changed path and versions") and the first presence (`wake.payload.path`)
     use `changes`;
   - when `more` is set, the prompt tells the agent the change set has more readable changes, which it can read with
     its folder tools;
   - the snapshot-v1 shape is dropped (3 October).
8. **The routine rules and trigger** (§2).

## 8. The hook for H2c (P31)

H2c needs every landed change set in seq order, inside the transaction that admits its wakes (F2). P29 ships two
functions with no-op bodies, and P31 replaces them (`create or replace`, its own body marker):
- **`qorpera_folder_listener_targets(env, commits jsonb) returns jsonb`** returns `{targets, sessions, admit}`. It is
  called once a step, before the ranks, with the step's change sets and the recorded failures it will retry.
  - `admit` is true when the hook will insert a wake, so the drain takes admission even if no listener wake is
    inserted. Otherwise P31's insert would hit 'Folder wake admission is required'.
  - `targets` are lock targets for `company_enter` at ranks 1 to 3: the woken agent's staff row and execution
    authority, and the payer's member row (F2).
  - `sessions` are conversations the drain takes KEY SHARE at step 7, so no session lock is taken after admission.
  - It is a plain read. The drain accepts only that shape (`qorpera_folder_listener_targets_valid`: targets at ranks 1
    to 3, KEY SHARE, keyed `<profile>:<uuid>` in this company; session ids; a boolean). If the call raises or answers
    anything else, the step goes on without the hook: `_commit` is not called, and each change set it would have heard
    (and each retry) is recorded as a failure with that SQLSTATE, `QP29T` for a malformed answer (review r1 F3). A lock
    timeout or deadlock in the call answers `busy` before any lock is taken (review r2 N2). `when others` does not catch
    a statement timeout (`query_canceled`) or a failed assertion: a targets hook that always hits one fails every step,
    so P31's must not (review r2 N5).
  - The drain takes the hook's `sessions` only within this company.
- **`qorpera_folder_listener_commit(env, commit jsonb) returns void`** is called per change set, in seq order, after
  admission. `commit` is `{commitId, seq, actor: {kind, id}, runId, paused}`.
  - `actor` is the commit's: `kind` is `member`, `platform` or `staff_agent`, and `id` is the user, null, or the staff
    agent. A run's or a view's commit has kind `staff_agent` with the agent's id, and `runId` says which run.
  - The hook reads its own units through the commit-and-key index (H2c: `human-tasks/`), so a large change set never
    sits in memory.
  - `paused` tells H2c that its wakes would come out cancelled, so it does not mark them as delivered (F2).

**Rules for P31:**
- After admission, the commit hook takes no lock except a foreign key's KEY SHARE on rows its targets named, and the
  rows of its own tables (H2c's markers). This holds only if H2c's own timed scan also takes its marker rows after its
  admission, never before, or the scan and the drain could wait on each other; P31 says so.
- When `paused` is true, H2c inserts no wake and leaves its marker unset; its own scan wakes the agent after the resume
  (F2).
- Each call runs in a subtransaction and counts toward the 46.
- A lock timeout or deadlock is never caught: it fails the step, which is tried again.
- Any other failure never fails the step, never holds the cursor and never blocks another company, but it is not
  dropped either (decision 6).
  - It is recorded in `qorpera_folder_listener_hook_failures(environment_id, commit_id, seq, sqlstate, constraint_name,
    attempts, last_attempt_at)`.
  - Each later step first calls the hook again for the environment's recorded failures whose wait is over (read again
    under the lease, so one another step just called waits), oldest seq first and at most 4 a step, with their own targets and the current `paused` flag, and deletes a row once its call
    succeeds. The wait is 5 s after the last attempt, doubling to at most 10 minutes
    (`qorpera_folder_listener_retry_at(attempts, last_attempt_at)`), so a hook that stays down is not called on every
    pass. H2c dedupes, so calling it again is safe (F2). A retried change set reaches H2c after newer ones, so H2c acts
    on a task's current state, not the old change's.
  - The table has RLS on, cascades from the folder clock, and stores the SQLSTATE and constraint name, never the error
    text (which may quote a path).

**Companies with no listener:** their commits still reach the hook. The due list counts every environment whose clock
is ahead of its cursor, or with a recorded failure whose wait is over (§9). Such a step is cheap: the fence, rank 0, the
lease, the hook, the cursor.

## 9. Scheduling: the shared folder drains

The coordinator (4 October) made the orchestrator step shared: a **folder drains** step before the folder materializer,
which each per-company drain plugs into as a due list and a per-company action. P29's `listen` is the first. F2-5b-3
(the worker drain), S3's 3i-b (machine events, `machine_events`, built; the quiet coding check-ins follow coding
dispatch on folder-v2 with C3), the one idle rule's check-ins (`machine_checkins`, 20260930091000) and A1's 3l-2
(office wakes) plug in the same way, adding one entry to two tables and
touching nothing else here.

**SQL, per drain `<x>`** (both service_role only, revoked from every other role):
- **The due list:** `qorpera_folder_<x>_due(p_after_environment uuid default null, p_limit integer default 100) returns
  jsonb`, a plain read (stable), with the limit 1 to 500 (else 22023). It answers
  `{items: [{environment_id}], has_more, next_after_environment_id}` in `environment_id` order after the cursor;
  `has_more` is true when the page is full, and the next cursor is the page's last id, else null.
  - It leaves out companies being deleted (`qorpera_company_deleting`) and those not on `folder-v2`.
  - It leaves out paused companies when the drain does nothing while paused; otherwise each would be asked on every
    pass. P29's keeps them, since a paused step moves the cursor past the pause (§4 step 5).
- **One company:** `qorpera_folder_<x>_company(p_environment_id uuid, p_limit integer) returns jsonb`, one RPC and so
  one transaction, at read committed, with the drain's own maximum for `p_limit` (at most 256). It answers
  `{state, ...}`, where `state` matches `[a-z_]{1,32}`; the orchestrator reads nothing else.
  - A drain answers rather than raises where it can: `busy` on lock_not_available or deadlock_detected around its
    locked part, `paused`, `idle`, `deleting`, `not_folder`.
  - Anything it raises is that company's failure for that drain (below). It never blocks another company or drain.

**The edge function** (`supabase/functions/runner-orchestrator/runner-orchestrator.ts`):
- the closed table `FOLDER_DRAINS` maps a drain name (`^[a-z][a-z0-9_]{0,31}$`) to `{due, company, maximum}`:
  today `listen: {due: 'qorpera_folder_listen_due', company: 'qorpera_folder_listen_company', maximum: 256}`,
  `workers: {due: 'qorpera_folder_workers_due', company: 'qorpera_folder_workers_company', maximum: 32}`,
  `human_tasks: {due: 'qorpera_folder_human_tasks_due', company: 'qorpera_folder_human_tasks_company', maximum: 32}`,
  `machine_events: {due: 'qorpera_folder_machine_events_due', company: 'qorpera_folder_machine_events_company',
  maximum: 64}` and `machine_checkins: {due: 'qorpera_folder_machine_checkins_due',
  company: 'qorpera_folder_machine_checkins_company', maximum: 64}`;
- two generic actions:
  - `folder_drain_due {orchestratorId, drain, afterEnvironmentId?, limit ≤ 500}` calls `due` with
    `{p_after_environment, p_limit}`;
  - `folder_drain_company {orchestratorId, drain, environmentId, limit ≤ maximum}` calls `company` with
    `{p_environment_id, p_limit}`;
- a name not in the table answers 400. Each new drain is one more entry: the edge side is additive, as #756's was.

**The orchestrator** (`CloudFolderDrains` in `packages/runner-orchestrator/src/orchestrator.ts`):
- `CLOUD_FOLDER_DRAINS` lists the drains in the order they run, each `{name, companyLimit}`: today
  `[{name: 'workers', companyLimit: 32}, {name: 'listen', companyLimit: 32}, {name: 'human_tasks', companyLimit: 32},
  {name: 'machine_events', companyLimit: 8}, {name: 'machine_checkins', companyLimit: 8}]`;
- each reconcile pass (every 2 s) runs every drain in order, then `CloudFolderRunMaterializer`, so a wake a drain
  admits becomes a run in the same pass;
- each drain pages through its due list, 100 at a time, and asks for each company in its own request;
- **pause and backoff, per drain:** a 400 (an edge function without the drain) pauses that drain for 10 minutes; any
  other failure of its list, or a page whose cursor is lost or does not move forward, backs that drain off for 1 s,
  doubling to at most 5 minutes; a full listing clears it;
- **backoff, per drain and company:** a company's failed request backs that company off for that drain alone, on the
  same schedule; a success clears it, and a company no longer listed is forgotten once its wait has long passed;
- every failure goes into the pass's `RoutineWakeAdmissionErrors`, and none stops another drain, another company or
  the materializer.

**Adding a drain:** the two SQL functions with their own tests; one `FOLDER_DRAINS` entry; one `CLOUD_FOLDER_DRAINS`
entry, whose place in the list is its place in the pass (core §11 C4 puts F2's worker drain before `listen`); then
re-pin the Runner Orchestrator, shared execution and LXD provider artifacts (run
`node --test scripts/package-*.test.mjs scripts/test-jitless-services.test.mjs` on a node for the values). Deploy
order: the migration, then the edge function, then the orchestrator roll. An orchestrator that is ahead of its edge
function gets the 400 and pauses only that drain.

**P29's due list:** `qorpera_folder_listen_due` lists the folder-v2 environments whose clock is ahead of their cursor
(an absent cursor counts as behind) or that have a recorded hook failure whose wait is over (§8), leaving out companies
being deleted, through the clock, the cursor and the failures.

**3i-b's due list** (`machine_events`, C1C §6.20): the folder-v2 environments with a waiting machine event whose
parent run is ready for it, has stopped or is gone, leaving out companies being deleted or paused (the step does
nothing while paused). A parent still running, or one whose last continuation has not run yet, asks nothing, so a long
run's events cost no request per pass. One step delivers up to 8 parents' events, a wake each.

**The check-ins' due list** (`machine_checkins`, the 2026-10-03 amendment "one idle rule for every machine", item 5):
the folder-v2 environments, not paused or being deleted, with a busy shell whose agent is due a question not asked yet
(a mark of 1, 3 or 7 hours, then every 24, since the agent last worked with it), or with a waiting question whose
parent run is ready, stopped or gone. Each question goes to the conversation of the run that started a program still
running there. A step asks first (a new question goes out in the same step only if its parent was already due; the
others wait for the next step), then continues up to 8 parents, a wake each with up to 8 questions that still stand. It
reads each parent's state again under admission, so concurrent steps continue a parent once at a time. A question no
longer standing is suppressed. The wake's source kind is `machine-checkin`, continued with C1c-3i-b's helpers as a
machine event is.

Commits do not nudge the orchestrator. A file wake waits one 2 s pass while one step's window covers the company's
backlog; with N listeners a step reads 512/N seqs (at most 32), and each company gets one step per pass, so a large
backlog takes several passes. The drains run company by company before the materializer, and a company whose routine
row is held spends its 2 s lock budget each pass; at today's scale that is fine, and a per-pass time budget or calling a
company again while `more` is true can follow (review r1 F13).

## 10. Erasure

The wake row holds version ids, not paths (§6). So:
- an erased change drops out of a wake by itself;
- `qorpera_folder_read_wake` never shows it;
- the wake identity guard needs no change.

What remains for P18's drain is runs that already read such a wake. In phase 1, for each commit whose versions it
erases, it also notes the runs of the company-file wakes whose `source_id` is that commit, through a new index on
`qorpera_wake_occurrences (source_id) where source_kind = 'company-file'`. Phase 4 then scrubs those runs' receipts and
reviewed cards as for any noted run. Phase 2, scrubbing each such commit's units, notes the same runs again, so a run
that read its wake just before phase 1 committed is not missed.

## 11. Routine expiry

After P28, `qorpera_expire_cloud_routines()` has no caller: its only caller was the legacy file drain, which P28 took
out of reconcile. P29 checks expiry itself before every wake (§4 step 6), so a stale `active` routine never raises at
insert. Routine expiry on folder-v2 as a whole (status, schedules) is Q1's, in the dynamic routine tick (§14, item 9).

## 12. The split

- **P29a** (migration 20260930020000; SQL tests 887 for the listener, drain, refusals, hook and erasure, and 888 for
  races):
  - the cursor and hook-failure tables;
  - the drain, due and hook functions;
  - the commit-and-key index on path versions and the company-file index on wakes;
  - everything in §7 except the runtime, and `qorpera_folder_read_wake` (§6);
  - STATE-FILES.md's routine section (file-change accepted; an edit drops undelivered changes) and core §6's activation
    wording (activation from the saving commit's seq), and C1B on `turn_run_id`;
  - erasure's run noting;
  - the shared folder-drains step (§9): the orchestrator's `CloudFolderDrains` and the edge function's generic actions.
- **P29b** (runtime): §7 item 7.

P29b must be live before P29a's wakes are read, or both go in under one paused cut (as P28 requires for `companySeq`).

## 13. Tests

887:
- **Matching:** a write, a delete, a move from and into the watch, an ancestor's move and a copy, each waking once with
  its changes; `exact` against `subtree`; a refused unit never wakes.
- **Self rule:** a run's commit; a coding session's commit during a turn (its turn run as parent); a desktop's commit
  after its run.
- **Read rights:** an unreadable match is never named or counted; a readable 22nd is found behind unreadable ones; a
  grant narrowed before the run reads its wake drops that change.
- **Activation:** no wake for the saving change set; a resume starts from the resume.
- **No stuck listener:** a listener at its `runs` limit, an expired one, an archived agent, a `required` routine with no
  session, and 33 listeners on one change. In each case the other listeners still wake.
- **Pause:** a paused company writes nothing, and the cursor moves on.
- **Bounds:** 21 versions, 32 wakes and 46 subtransactions per step; a 100,000-entry move read through the index (plan
  check).
- **Plans:** a ChatGPT plan cannot pay for a file-change routine, nor for a wake that follows one.
- **The hook:** order, arguments and the paused flag; a failure is recorded and called again until it succeeds; a lock
  error fails the step.
- **Erasure:** an erased version drops out of a wake, and a run that read the wake is noted.
- **The materializer** runs a file wake (with P28 merged).
- **The refusals of §7** are gone.

888 (dblink):
- two drains of one company: the second answers `busy`;
- a drain against the company purge: they meet at the fence, never in a cycle;
- a drain against a commit that edits the routine, against routine firing, and against the materializer;
- no commit waits on a drain's lease.

## 14. Decisions

Taken by the coordinator on 4 October 2026:
1. One cursor per company; each routine listens from the change set that saved it.
2. Editing a routine drops the changes the drain had not reached; the routine docs say so.
3. A paused company's file wakes are not replayed after resume. **Amended (review r1):** the drain writes no wake rows
   during a pause, rather than cancelled ones, since cancelled rows count toward a routine's `runs` limit.
4. A path the agent may not read gives no wake and is never named, nor counted in `more`.
5. Bounded payload with `more`. **Amended (review r1):** the wake holds version ids, and the paths are built when the
   run reads its wake, so erasure needs no scrub and read rights are checked again at delivery.
6. Two hook functions for H2c. A hook failure never blocks the drain or other companies, and is recorded and called
   again until it succeeds.
7. P29a (SQL and the orchestrator step) and P29b (the runtime), on master after #756; the runtime first or in the same
   paused cut.

Also taken on 4 October:
8. **Coding sessions' saves** take `turn_run_id` as the causal parent (§5). P29a amends C1B so that `turn_run_id` is both
   attribution and the causal chain, so self-fencing applies to it. (The decision named the 16-agent chain stop too; that
   stop no longer exists since 24 September, review r1 F2: see §5 and item 10.)
9. **Routine expiry on folder-v2** (status and schedules) goes to Q1, in the folder-v2 dynamic routine tick (P04's
   per-company pass). P29 keeps its own expiry check before each file wake (§4 step 6).
10. **No chain fence for file wakes** (coordinator, 4 October, on review r1 F2): the live rule stands, as Jonas set it
    on 24 September ("no caps on agents' work", #265). An agent's own change never wakes it, unknown provenance is
    refused, and Stop, a `runs` limit or a pause ends a loop. A file-wake-only fence would also block two agents working
    back and forth on the same files. The chain stays visible instead: the wake row (and the run's envelope, `source`,
    `parentRunId`, `causal`) names the change set, the run that made it and the agents in the chain.

## 15. Built

**P29a** (migration 20260930020000; SQL tests 887 and 888):
- the tables `qorpera_folder_listener_cursors` and `qorpera_folder_listener_hook_failures`, RLS on, revoked from every
  role;
- the indexes on path versions `(commit_id, (qorpera_folder_key(path)) collate "C")` and `(commit_id, prior_version)
  where op = 'move_out'`, and on wakes `(source_id) where source_kind = 'company-file'`;
- the new functions: `qorpera_folder_listener_actor`, `_listener_matches`, `qorpera_folder_file_wake_readable`,
  `_file_wake_changes`, the hook pair `qorpera_folder_listener_targets` / `_listener_commit` (no-ops until P31),
  `qorpera_folder_listener_targets_valid`, `qorpera_folder_listener_retry_at`, `qorpera_folder_listen_due` and
  `qorpera_folder_listen_company`;
- the patches of §7 (each body carries the marker 20260930020000; the deploy guard checks them): the trigger check,
  the routine trigger and rules, the pin trigger, the wake policy, the run resolve, `qorpera_folder_wake_authorized`,
  `qorpera_folder_read_wake` (`changes` built at read time, and `actorUserId`), `qorpera_routine_occurrence_count` and
  erasure's run noting (§10);
- the shared folder-drains step (§9): `CloudFolderDrains`, the edge function's `FOLDER_DRAINS` and its two actions,
  and the re-pinned Runner Orchestrator, shared execution and LXD provider artifacts.

**P29b** (runtime): the wake envelope parser takes the closed `qorpera.folder-file-wake/v1` payload
(`schema, seq, commitId, changes ≤ 21, more ≤ 1000`; each change `path, op, version`, with `priorVersion` and, for a
`move_in` only, `from`); the prompt names `wake.payload.changes` and `more`; the first presence is the first change's
path.

**Tested,** 887:
- the trigger's shape, activation from the saving change set, the run resolve accepting file wakes;
- matching: exact and subtree, a sibling beside the watch, a move out and a move in, a copy at its target and not at
  its source, a delete; a move in names its readable source at read time;
- read rights: a member-private path alone gives no wake, and beside a readable one is neither named nor counted; a
  grant narrowed after the wake drops the change at read time, and `qorpera_folder_wake_authorized` refuses the wake;
  a hidden change drops the stored `more` too;
- the self rule: a run's commit never wakes its own agent, and another agent's wake carries the run as parent and both
  agents in the chain;
- 21 versions with `more`; 39 listeners on one change set: 32 wakes in one step, 7 in the next, each once;
- a routine at its occurrence limit is passed over and the others wake; an archived agent's listener is set aside
  (`inactive`); a paused company writes no wake, moves on and does not replay after the resume;
- the hook: change sets in seq order with their actors and the paused flag; a failure recorded with its SQLSTATE only,
  the cursor moving on, no call before the wait, then called again until it succeeds; the doubling waits; a lock error
  in the hook undoing its whole step;
- nothing holds the cursor: a targets hook that raises or answers a malformed shape (the change sets recorded for the
  hook, then delivered once it answers), a stored trigger that no longer validates;
- the run's wake read end to end (`qorpera_read_native_wake` on a hand-built leased run of a file wake): the closed
  payload, its changes, `actorUserId` for a member's commit;
- erasure noting the run of a file wake about an erased change (phase 1 or 2; the test does not tell them apart);
- grants, the lock text (the lease after the ranks, no 40001, the 2 s budget) and RLS.

888 (dblink): two drains of one company; the drain against the company purge in both orders; a commit never waits on a
drain; a save of the listener meets the drain at the routine row.

The orchestrator (vitest): the drains' requests and validation, a drain's 400 pause, the per-drain and per-company
backoff. The edge function (node --test): the generic actions and the closed name table. The runtime: the envelope
parser and the first presence.

**Not tested yet** (from §13): a coding session's commit during a turn and a desktop's commit after its run; an
ancestor's move under an `exact` watch and a refused unit; a readable 22nd behind unreadable ones; a resume starting
again; an expired routine alone and a `required` routine with no session; the 46-subtransaction bound and a
100,000-entry move; the ChatGPT plan refusals; each erasure phase's noting on its own; P28's materializer making the run (887
builds it by hand); a SQL-built folder-v2 file wake envelope run through the TypeScript parser (887 checks the
payload's keys, `cloud-wake-bus.test.ts` the parser; `scripts/test-runtime-wake-bus.mjs` dropped its snapshot-v1 File
envelope); the drain against routine firing and against the materializer.

**Who writes a listener** (4 October, after the live check on 10c3ee8c):
- **Agents:** `manage_routine` on folder-v2 takes `file_change` (Q1, #837). It writes `when: file-change`, `watch`, `match`
  and the time zone into the routine's file, and its description gives the rules of §2.
  - Before this, the tool refused the trigger and told agents that file routines were not available, so nothing could make
    a listener: runs d59f0a93 and 231d7f2c.
- **Members:** the web routine editor offers it next (Interfaces), once the runtime part has shipped.
