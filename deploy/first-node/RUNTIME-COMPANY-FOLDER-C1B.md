# C1b: agents and authority on the folder core

C1a (#408, merged 823f1550e) built the folder core for members and the
platform. C1b lets agents read and write it: as a live run, and later as the
holder of a mount that outlives a turn. It also adds the authority checks
around agent access, and the call sites of the structured-file hook that F2
fills (RUNTIME-COMPANY-STATE-FILES.md §7, #421).

This page refines RUNTIME-COMPANY-FOLDER-CORE.md §3 and §4 with what two
read-only inventories of today's code found (2026-09-28). It changes no
decision of the contract or the core design. Where the code differs from what
the core design assumed, this page says so and records the choice.

## What the inventories changed

1. **No run can exist on a folder-v2 company yet.** Runs and jobs require a
   substrate and snapshot, and every materializer refuses a company without a
   head. So C1b is built and tested on hand-made run, job and wake rows. Real
   runs arrive with C3 and C4.
2. **Today's run checks cannot be reused.** Every helper in the chain takes
   the job `FOR UPDATE`, some several times, and the profile row `FOR UPDATE`.
   `qorpera_wake_authorized` takes per-kind rows `FOR SHARE NOWAIT`, before it
   reads members and staff. So C1b writes its own folder-v2 run check, in the
   core §3 order.
3. **Two leases, and a save can outlive one of them.** The native provider
   lease (120 s, renewed every 45 s) is released when execution ends. The
   whole-tree lane releases it before completion, while the job (a 6-minute
   lease) is still held. The run box's last save falls in that gap.
4. **Some saves have no run at all.** A company-machine shell command and a
   coding session's program keep running after the turn ends. No SQL row
   records who they act for.
5. **Review is per tool call today.** A review is keyed by (agent, tool,
   argument digest), and the woken agent repeats the approved call. Nothing
   parks a change. Folder changes are reviewed per change set instead.
6. **A resource's `version` is the key its grants are stored under.** Bumping
   it drops every explicit grant. So authority revisions need columns of
   their own.
7. **C1a's operation keys** hash the whole actor and are scoped per company.
   A run's binding rotates on a lease re-claim, and receipts are per run.

## Slices

| Slice | Contents | Needed by |
| --- | --- | --- |
| **C1b-1** | Run actors in commit, read and list. Operation keys per run. Attribution. The folder pause. Explicit bases: `rules/` and the indexed resource resolver. Review classes and review enforcement. The structured-file hook's call sites and inert stubs. | F2 (hook, review class, session kind, causal wake), F3 step 2 and step 3 |
| **C1b-2** | Authority revisions on resources and grants, the folder resource and grant mutators, authority journal rows. Read sets and read records, and the recheck that effects call. Agent wakes (their parent's read check). | F3 step 2 ("the run's records stay a handful of rows"), every effect in C1c |
| **C1b-3** | Mount views: the authority row for a mount that outlives a turn. Company-machine computers, coding sessions, test machines, and the shell box after its run ends. Designed with F3. | F3 steps 4–6 |

Each slice is its own PR with its own independent review. C1b-1 comes first.

## C1b-1

### 1. Actors

`qorpera_folder_commit`, `qorpera_folder_read` and `qorpera_folder_list` take
these actor shapes:

| Kind | Shape | Authority |
| --- | --- | --- |
| member | `{kind:'member', userId}` | as C1a |
| platform | `{kind:'platform'}` | as C1a |
| run | `{kind:'run', runId, jobId, runnerId, assignmentId}` | the run's agent, for its requester and audience (§3) |
| view | `{kind:'view', viewId, pass}` | C1b-3 |

- **Binding fields.** `jobId`, `runnerId` and `assignmentId` are checked
  against the job row.
  - They detect a stale caller: a re-claimed lease, or another runner. They
    prove nothing on their own.
  - The caller is service_role, as in C1a: the runtime, or the node's folder
    service, which is trusted. If a caller outside that trust ever needs the
    run actor, it passes the job's `lease_token_sha256` as well.
  - The binding is not part of the operation key's digest (§4).
- **The resolved actor.** After its check, the commit passes the structured
  hook (§8) this object:

  ```
  {kind:'staff_agent', staffAgentId, staffVersion, runId, jobId,
   requesterUserId, audience:{kind, userId}, sessionKind, workerAccess,
   causalWakeId, wakeKind, routineId, routineVersion, fenceRevision}
  ```

  `workerAccess` is null for a run that is not a worker's. A member or the
  platform is passed as in its request.

### 2. The run check

Order, extending core §3 steps 1–5. Every effect runs at READ COMMITTED, as
C1a's commit already requires. "Plain" means a plain read. The pause lives in
`qorpera_company_execution_pauses`.

| Step | What | Lock | Refused when |
| --- | --- | --- | --- |
| 0 | a replay: the operation key, if it exists | plain | a stored outcome is returned at once, even while paused |
| 0 | the pause | plain | paused (55000). An effect refuses before it locks anything, so stop never queues behind new effects |
| 1 | the operation key | claim | – |
| 2 | the job, by `jobId` and `runId` | `FOR KEY SHARE` | not `leased`; another runner or assignment; `lease_expires_at <= clock_timestamp()` (42501) |
| 2 | the run | plain | another environment; `source_kind = 'proposal_review'`; past its deadline; its compute is unavailable (`qorpera_execution_compute_available`: the identity is active, no recovery is pending, the epochs match, and the logical computer is active and has the job's capability) (42501) |
| 3 | the folder fence | `FOR KEY SHARE`, then re-read the pause | paused (55000) |
| 4.1 | members: the requester | `FOR KEY SHARE` | not a member (42501) |
| 4.2 | staff: the run's agent | `FOR KEY SHARE`, through the hook's lock (§8) | not `active`, or `version < run.staff_version` (42501) |
| 4.4, 4.5 | the run's wake | `FOR KEY SHARE`, at its rank | not authorized for its kind (below) |
| 4.6 | covering resources | `FOR SHARE`, as C1a | – |
| 5 on | paths, objects, clock | as C1a | – |

**The run's wake.** It is found by `qorpera_wake_occurrences.run_id`, which is
unique.
- **Every kind:** when the wake names a session, the session is open, in this
  company, and bound to this agent (20260920030500:61-67).
- **By kind:**

  | Kind | Checks | Rows locked |
  | --- | --- | --- |
  | human, first-run | the session rule above | none beyond 4.1 and 4.2 |
  | routine, from a schedule | The routine is active, or expired while it was active (`expired_while_active`, 20260925107000:95: a finite routine's last occurrence expires it in the same insert), or concluded by this run. Its version is current, or the run is live and the current version has the same agent. The version's creator is the requester | the routine, rank 5, `KEY SHARE` |
  | routine, from a file change (`company-file`) | refused with 0A000 until C1b-2: it needs a path-authority check | – |
  | room | the room is active; the agent and the poster are active room members; the input is in the room | the room, then its two members, rank 4, `KEY SHARE` |
  | agent: coworker, worker dispatch and completion, office activation, machine event | refused with 0A000 until C1b-2 | – |

- **Agent wakes wait for C1b-2.** Their check includes "every path the parent
  run read is readable by this agent". On the folder core, that is a check
  against the parent's read records, which C1b-2 builds.
- **Coding and worker runs wait too.** Both are agent wakes (worker
  dispatch), so they arrive with C1b-2. C1b-1 still specifies and tests their
  path rules (§3), through the authority function with a resolved actor.
- **Session kind.** It is read from `qorpera_run_worker(run)`: species
  'coding' is a coding session, and anything else is in-house. In C1b-1 every
  run that passes is in-house.

**What the run check does not require:**
- **The native provider lease.** A save may land in the gap between the
  native lease's release and the job's completion (inventory point 3). The
  job lease is the run's liveness. Every live function that ends a job lease
  takes the job `FOR UPDATE`, directly or through terminalize, or uses `FOR
  UPDATE SKIP LOCKED` (claim, re-claim, reaper). So each waits out, or skips,
  commits in flight. The design review checked all 16 job writers.
- **Sponsor availability.** It governs model requests, not file saves. It is
  false once the job ends anyway, and it locks provider connections outside
  the rank order.

Compute availability stays: it takes no locks, and it carries the recovery
fence. Recovery does not end job leases itself, so without it, saves from an
old epoch would depend on the reaper being up.

**`KEY SHARE` on members, staff, routines and rooms** does not block a plain
status UPDATE (archive, role change, routine expiry): none of those columns is
in a foreign-key-usable unique index. An effect that checked "active" and
commits after the archive is serialized before it. That is today's outcome,
where the archive waits for effects in flight and then applies. The journal
may still give that save a later `seq` than the archive's own change, if the
archive writes to the folder.

**Reads.** `read` and `list` run the same checks as plain reads, with no
locks, in one statement. A paused company refuses run reads (55000), as
today's actor does. Runs keep no read provenance until C1b-2, so C1b-2 must
land before C3 gives agents real reads.

### 3. Authority for agents

A run's permission on a path, ported from today's
`qorpera_company_path_allowed` (20260828019850:77-95), with the folder
resolver:

- The requester (a member) is allowed, **and**
- by the run's audience:
  - `company`: the covering resource is not `member_private`, and the agent
    is allowed;
  - `member_private`: the audience member is the requester, the resource is
    not `member_private` or is the requester's own, and the agent is allowed;
  - any other audience: refused. Runs are only `company` or `member_private`
    (20260828019300:142).
- **A worker** (`workerAccess` set) follows today's worker rule
  (20260922170000:180-199; notebook layer 20260924020000:23-27):
  - with `access = 'read'` it writes nothing. Its todo's `brief.md` and
    `results.md` are platform-only on folder-v2 (#421 doc §2);
  - with `access = 'write'` it writes as its agent.
- **A coding session** has `agents` and `rules`, and everything below them,
  read-only (contract 5.6). The rule applies to each unit's `from` and `to`
  paths, the two folders themselves included. Until C2, `decide` is a stub,
  so this rule is what refuses a coding session deleting a seeded folder.
- **A subtree unit** checks the same boundaries as C1a
  (`qorpera_folder_member_keys_allowed`), for both principals at each
  boundary.
- **Members** go through the same principal wrapper, so an owner or admin
  writes `rules/` through the member path.

**Explicit bases in C1b-1:**

- **`rules/`.** `qorpera_folder_enable` seeds a `rules` resource with a new
  scope, `company_rules`:
  - every member reads it, and owners and admins write it;
  - an active agent reads it, and no agent writes it.

  How it is built:
  - `qorpera_folder_principal_allowed` wraps the shared principal check and
    handles this scope.
  - The resources scope check gains the value. snapshot-v1 never uses it.
  - The migration backfills the resource for companies enabled before C1b.
  - Default agent grants target only the root (20260926035000:158-165), so
    nothing else grants agents write on `rules/`.
  - F2's `rules_owner_only` reason is unreachable, because the resource
    refuses first, as `denied`.
- **Members' private folders.** They stay implicit, as today and as in C1a.
- **The code rules** (notebook, worker and todo, hiring) follow the agent's
  folder by id, which needs the `agent.md` index. They come with C2.

**The indexed resolver.** `qorpera_folder_path_resource` looks resources up
with an expression index on `(environment_id, qorpera_folder_key(path))`,
against the key and its ancestors (`= any(prefixes)`). That is at most one
index probe per path level, in place of C1a's scan of the company's
resources.
- An exact resource matches only its own key; a subtree resource also
  matches the keys below it.
- A tie between two resources that share a folder key still covers nothing
  (C1a).
- Core §2 promised a unique index on the folder key. The shared unique key
  folds ASCII only, and snapshot-v1 rows may already collide, so a plain
  unique index cannot be added to the shared table. The tie rule plus C1b-2's
  mutators, which refuse to create a tie, take its place. Core §2 is updated
  to say so.
- `qorpera_folder_member_keys_allowed` still scans the company's resources
  for boundaries inside a subtree. C1b-2 can move it to the index.

### 4. Operation keys

- **Scope.** `qorpera_folder_operation_keys` gains `scope_id`: the run's id
  for a run, the view's id for a view (C1b-3), and a fixed nil uuid for
  members and the platform. The primary key becomes `(environment_id,
  scope_id, operation_key)`.
- **Digest.** The request digest leaves out the binding. It covers `{kind,
  runId}` for a run and `{kind, viewId}` for a view, plus the units and
  `p_review_id`.
  - A replay after a lease re-claim returns the stored outcomes.
  - Two runs, or a run and a member, that pick the same key no longer
    collide.
  - A retry with another review id is a different change set (22023), not a
    silent replay of the old outcome.
- **Replays while paused.** A replay is looked up before the pause check, so
  a stored outcome is returned even while the company is paused.

### 5. Attribution

`qorpera_folder_commits` records, for a run:
- `actor_kind = 'staff_agent'` and `actor_id` = the agent; the requester;
  `run_id`; `causal_wake_id`;
- `audience` (the existing jsonb): `{kind, userId}`;
- the provider connection and the runtime bundle (existing columns), from the
  run;
- `approver_user_id` (existing): the answering member of an answered `ask`.

New columns:
- `session_kind` ('in_house' or 'coding');
- `routine_id` and `routine_version`, for a routine wake;
- `sponsor_binding_id` and `sponsor_version` (contract 4.2), from the run;
- `review_id` (§6).

### 6. Review in SQL

**Classes, per unit** (core §4):

| Actor | Class |
| --- | --- |
| member, platform, coding session | plain |
| in-house run | delete and move: `deletion`. Any other unit: the structured hook's `qorpera_folder_structured_review_class`, which is `plain` until C2 |

**The review record.** A new table, `qorpera_folder_reviews`, holds one row
per reviewed change set:
- the run and the change set's digest (the canonical units, without the
  binding);
- the unit numbers it covers;
- the reviewer's decision (`allow`, `ask` or `deny`);
- the answer, if asked (`allow` or `deny`, the answering member and the time).

The commit takes an optional `p_review_id`.

**Enforcement.** For each unit whose class is not plain:

| Review record | Outcome |
| --- | --- |
| absent; bound to another run or digest; or the unit's number is not in its set | `denied` |
| `deny`, or answered `deny` | `denied` |
| `ask`, not yet answered | `waiting_for_review`: reported and not applied. Until C2 the unit is dropped; C2 parks it as a proposal |
| `allow`, or answered `allow` | the unit is decided as usual; an answered allow records its approver |

**Locking.**
- The commit takes the review row `FOR SHARE`, at a new rank between grants
  (7) and vault rows (8), written 7b.
- Answering takes it `FOR NO KEY UPDATE`, which conflicts with `FOR SHARE`.
  So an answer waits for a commit in flight, and a commit waits for an answer
  in flight. Neither can act on a state the other is changing. With
  `KEY SHARE` the two would not conflict, and C2 could park a unit after its
  answer had already committed, leaving the proposal waiting forever.
- In C2, an answer that also applies parked units takes the review row at
  7b, after ranks 1–7, or applies them in a separate transaction.

**Recording reviews is C2.**
- C1b-1 has the table and the enforcement. Tests insert records directly.
  Until C2, a run's delete or move is denied, because no recorder exists yet,
  and no real run exists before C3 anyway.
- C2's recorder applies the kernel's layering, as `qorpera_record_action_review`
  does today (20260926130000:339; 20260926210000:78-100):
  - Ask first wins;
  - only a company Allow rule lifts a built-in check;
  - an ask becomes a deny where no card can be raised (2026-09-25 amendment,
    item 5; RUNTIME-COMPANY-FOLDER.md:244-246);
  - a deny stands for its run and conversation (item 6).

  Contract item 4: "the kernel enforces this ordering". Cards, member answers
  and parked proposals come with it.

### 7. The folder pause

Stop is two phases (core §9), in two transactions:
1. `qorpera_folder_pause(profile, reason)` commits the pause row in
   `qorpera_company_execution_pauses`. New effects refuse at step 0 without
   locking anything.
2. `qorpera_folder_pause_drain(profile)` takes the folder fence with an
   explicit `SELECT … FOR UPDATE`, which waits out the effects in flight, and
   bumps its revision.
   - A plain UPDATE would take only `FOR NO KEY UPDATE`, which does not
     conflict with the effects' `KEY SHARE`.
   - PostgreSQL grants a new `KEY SHARE` even while a `FOR UPDATE` waits. So
     an effect can take the fence during phase 2, but it re-reads the pause
     after its lock and refuses. The drain is bounded by the effects that
     were already past step 0 when phase 1 committed.

Resume is one transaction: the fence `SELECT … FOR UPDATE`, delete the pause
row, bump the revision.
- Both functions are operator-only, like today's pause.
- Today's `qorpera_set_company_execution_pause` takes the profile row `FOR
  UPDATE`, so it must refuse folder-v2 companies. That refusal is part of
  C1c's per-caller decisions.

### 8. The structured-file hook

C1b-1 adds F2's six functions with the signatures agreed on #408 (comment
of 2026-09-28 07:07Z), and calls them from the commit:

| Step | Call |
| --- | --- |
| 4, before any lock | `qorpera_folder_structured_targets(env, actor, units)` |
| 4, per range | `qorpera_folder_structured_lock(env, targets, from_rank, to_rank)` for ranks 2, 4–5 and 8–9. The commit locks ranks 1, 3, 6, 7 and 7b itself |
| 7, per unit | `qorpera_folder_structured_decide(env, actor, commit, unit_no, unit, eff_path, eff_to)`, after the generic checks |
| 7, per unit | `qorpera_folder_structured_review_class(env, actor, unit, eff_path, eff_to)` |
| 8, per clean unit | `qorpera_folder_structured_apply(env, commit, unit_no, unit, eff_path, eff_to)` |
| 9 | `qorpera_folder_structured_verify(env, commit)` |

`actor` is the resolved actor of §1.

**One target list, merged before locking.**
- Before any lock, the commit merges:
  - its own rows: the requester, the agent, the wake's room, room members or
    routine;
  - the hook's targets.
- Rows merge by `(table, key)`, and the strongest mode wins. So no row is
  ever locked twice or upgraded; KEY SHARE and then FOR UPDATE on one row
  would deadlock two commits (core §3: a lock is never upgraded).
- Each table has a fixed rank. Within a rank, tables go in a fixed list order
  and rows in key order:
  - rank 4: `qorpera_company_rooms`, then `qorpera_company_room_members`;
  - rank 5: sections, routines (`qorpera_cloud_routines`) with their cursors,
    todos, connections, rules, in the order F2 fixes.
- **Keys.** A uuid table's key is the uuid as text. Keys with no single uuid
  are encoded:
  - staff: `profile_id:staff_agent_id`;
  - room members: `room_id:principal_kind:principal_id`, which sorts by room,
    then kind, then id: today's order (20260920030500:48-51).

  F2's claim keys keep F2's encoding.

**Stubs.**
- `targets` returns no rows.
- `decide` returns `{ok: true}`.
- `review_class` returns `plain`.
- `apply` and `verify` do nothing.
- `lock` really locks the merged targets in its rank range, in the order
  above and in each row's merged mode. It knows the tables the run check
  needs: `qorpera_profile_staff`, `qorpera_company_rooms`,
  `qorpera_company_room_members` and `qorpera_cloud_routines`. F2's version
  keeps locking every target it is passed, whatever table it is in.

### 9. Tests (C1b-1)

- **The run check.** Hand-built job, run, wake, session, routine and room
  rows. A leased run saves. Refused with 42501, and nothing applied:
  - a job not leased, expired, or re-claimed by another runner;
  - the wrong environment;
  - compute unavailable, or a recovery epoch that moved on;
  - staff archived, or the requester not a member;
  - a routine paused;
  - a room member removed, or a room session closed.

  A routine that expired while active still saves. An agent wake and a
  `company-file` routine wake are refused with 0A000. A paused company is
  refused with 55000 before any lock.
- **Authority**, through the authority function with resolved actors:
  - audience company against a member-private resource; audience
    member_private for another member;
  - `rules/`:
    - a viewer reads it;
    - a contributor writes nothing, a move by a contributor included;
    - an admin writes through the member path;
    - an agent reads it after its root grant is revoked, and cannot write
      it;
  - a read-access worker writes nothing, and a write-access worker writes
    as its agent;
  - the coding rule on `agents` and `rules` themselves, and below them, as a
    `from` and as a `to`.
- **Operation keys:**
  - a replay after a lease re-claim returns the stored outcomes;
  - two runs, and a member and a run, use one key and each save;
  - a replay while paused returns the stored outcome;
  - the same key with another `p_review_id` is 22023.
- **Review.** A delete by an in-house run:
  - denied with no record;
  - saved with `allow`;
  - saved with an answered `allow`, recording its approver;
  - `waiting_for_review` with `ask`;
  - denied with a record bound to another digest, or not listing the unit.
- **Attribution.** Every new column, and the existing ones filled from the
  run.
- **Concurrency (dblink):**
  - A commit holding the job `KEY SHARE`:
    - makes the real cancel and terminalize wait;
    - is skipped by claim and the reaper;
    - does not make a renewal at `FOR NO KEY UPDATE` wait.
  - Two commits of one run do not block each other.
  - Stop phase 2 waits for an in-flight commit. A commit that starts after
    phase 1 refuses without waiting. A stream of commits does not starve
    phase 2.
  - Staff archive does not wait for a commit.
  - Review races, in both directions: an answer waits for a commit, and a
    commit waits for an answer.
  - The hook merge takes no lock twice: a room member held for both the
    check and a hook target is taken once, in the stronger mode.
- **Static checks:**
  - every function that ends a job lease takes `FOR UPDATE`;
  - run reads take no locks;
  - resolver edge cases (exact against subtree, ties, private folders) by
    result, not by raw EXPLAIN.

## C1b-2 (outline; its own design review)

- **Revisions.** Resources gain `authority_revision` (structural: a policy
  change, or a narrower resource inserted under it, which bumps the covering
  parent). Grants gain `revision`, bumped on narrowing or revocation.
  - Principal changes that narrow with no resource or grant write are
    checked directly at effect time: grant `expires_at`, staff archive,
    member role and removal.
  - Every change writes an authority journal row (`kind = 'authority'`) with
    what changed.
- **Mutators.** Folder-v2 resource and grant functions take `FOR NO KEY
  UPDATE` on the rows they change, and on the covering parent when they
  narrow, at ranks 6 and 7. They replace the old mutators, which reach
  folder-v2 only through `qorpera_company_path_actor` and refuse there.
  - They refuse to create a resource that ties another's folder key.
  - **Narrowing must not starve.** Every commit holds its covering resources
    `FOR SHARE`, usually the root. PostgreSQL grants new shared lockers while
    an exclusive one waits. So narrowing goes in two phases, like stop:
    1. commit an intent that effects read before they lock;
    2. then take the rows.
- **Read sets.** `qorpera_folder_run_reads`, keyed by (run, covering
  resource, agent grant), with the oldest unchecked revisions,
  `least(recorded, observed)`. Written by run reads and listings.
- **Read records.** `qorpera_folder_run_read_records`, one row per release
  (the runtime releases per model request) and covering resource. Each holds
  a sorted list of (path, version, content hash, range or page) and the
  output digest.
- **The recheck.** `qorpera_folder_run_reads_current(run)`, for effects:
  - `FOR SHARE` on the read set's resource and grant rows, merged into the
    commit's rank-6 and rank-7 passes (one order, no second lock);
  - compare the revisions;
  - on a change, re-resolve only the paths under the changed prefix, from the
    read records;
  - re-stamp as a compare-and-set.
- **Agent wakes.** Their check becomes the parent run's read set, rechecked
  for the recipient agent. Coding and worker runs arrive with them.
- **`company-file` routine wakes** get their path-authority check here.
- **Measure in C1e:** a member's Stop takes the job `FOR UPDATE`, and can wait
  behind overlapping commits of one run.

## C1b-3 (outline; designed with F3)

A **view** is the SQL authority row for a mount: F3's "every mount is a view
with one owner". It is the one place a save that outlives a turn can be
checked and attributed.

- **Table.** `qorpera_folder_views`:
  - kind: run box, company-machine computer, coding session, or test machine;
  - the agent, and the member it acts for;
  - the run that opened it;
  - the computer's screen, generation and epoch, or the coding session's
    worker and attachment;
  - the pass's hash, state, `lease_until`, and the time it was last renewed.
- **Lock order: the job, then the view**, both in step 2.
  - A view opened by a run is ended by every path that ends the run's job:
    job first, then view, the same order as a commit.
  - A view with no run (after a turn) locks only itself.
  - Renewal is `FOR NO KEY UPDATE`. Closing, holder changes and expiry take
    `FOR UPDATE`, which waits out commits in flight.
- **Holder changes.** On a company machine, the office and screen changes of
  inventory §1.2 update the view's holder. Two of them today clear leases
  with plain UPDATEs, so they would not wait for commits holding a lock:
  `qorpera_begin_runtime_office_lifecycle` and the office-wide fences. C1b-3
  gives those paths an explicit `FOR UPDATE` on the view. They are shared
  with snapshot-v1, so the change is a branch on the company's core.
- **Authority.**
  - A run box acts as its run.
  - A computer acts in the company-wide view and within its holder's own
    authority. The company-wide view is the paths whose covering resource is
    the root, plus `rules/`, which every agent reads.
  - A coding session acts as agent ∩ member, with `agents/**` and `rules/**`
    read-only.
  - A test machine acts as the agent that started it, for that run's
    requesting member: today's rule always needs a member
    (20260828019850:82-84).
- **Saves after a turn.** They are attributed to the view's agent and member.
  A unit that needs review waits until the agent's next turn (F3 page,
  "Programs that outlive a turn").
- **Open questions for F3:**
  - the pass format;
  - which member a coding session acts for (owner or requester; the
    who-pays work makes them the same);
  - how often views are renewed;
  - whose member authority applies to a computer or shell view after its run
    ends.

## Not in C1b

- Real runs on folder-v2 companies: C3 and C4.
- Effects' folder-v2 branches (sends, completion, context views, coworker
  messages) and the old writers' refusals: C1c.
- Moving job renewal to `FOR NO KEY UPDATE`. It is a branch on the company's
  core inside a runner RPC, and it only matters once folder-v2 runs exist, so
  it lands with the first real runs (C3). Until then renewal's `FOR UPDATE`
  only waits for commits, which are short.
- Cards, member answers and parked proposals: C2.
