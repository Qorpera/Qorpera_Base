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
| **C1b-2** | Authority changes ordered through the clock (commits no longer lock covering resources), revisions, the folder resource and grant mutators, authority journal rows. Read receipts, read sets and read records, and the recheck that effects call. Agent wakes (their parent's read check), coding and worker runs. | F3 step 2 ("the run's records stay a handful of rows"), every effect in C1c |
| **C1b-3** | Mount views: the authority row for every mount. C1b-3a: run boxes, computer desktops and coding sessions. C1b-3b: computer shell commands and test machines, after #411 and #419. Designed with F3. | F3 steps 4–6 |

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
| 1 | the operation key | claim | a concurrent claim that commits first makes this a replay |
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
  company, and bound to this agent, with today's variants carried over: a
  room session binds through the room, and a routine run's session follows
  the routine audience rule (20260920030500:61-67; 20260922170000:277-280).
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

**Also carried over from today's actor** (20260920030500:384-401): the run's
session still has the run's audience, and each of the run's inputs is still
bound to its session, run, author and runtime bundle.

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
- **An in-house worker** (`workerAccess` set and `sessionKind =
  'in_house'`) follows today's worker rule (20260922170000:180-199; notebook
  layer 20260924020000:23-27):
  - with `access = 'read'` it writes nothing. Its todo's `brief.md` and
    `results.md` are platform-only on folder-v2 (#421 doc §2);
  - with `access = 'write'` it writes as its agent.

  A coding worker's `access` is always `read` (dispatch forces it,
  20260922230000:376-378). There it describes the dispatch's sources, not
  folder writes, so the worker rule does not apply to coding sessions.
- **A coding session** writes as agent ∩ member, with `agents` and `rules`,
  and everything below them, read-only (contract 5.6). The rule refuses
  writes only, so a coding session can still copy a file out of `agents/`. The rule applies to each unit's `from` and `to`
  paths, the two folders themselves included. Until C2, `decide` is a stub,
  so this rule is what refuses a coding session deleting a seeded folder.
- **A subtree unit** checks the same boundaries as C1a
  (`qorpera_folder_member_keys_allowed`), for both principals at each
  boundary.
- **Members** go through the same principal wrapper, so an owner or admin
  writes `rules/` through the member path.
- **Reads are stricter than C1a** about the actor's shape: a member or
  platform actor with extra keys is invalid (22023). C1a ignored extra keys.

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
    refuses first, as `denied`. So is `coding_session_read_only`: the coding
    rule refuses first.
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
  unique index is not added to the shared table. (One on a trigger-set,
  folder-v2-only key could be; the tie rule, which fails closed, is enough.) The tie rule plus C1b-2's
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
- the provider connection, from the run's sponsor version, and the runtime
  bundle, from the run (existing columns);
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

The commit takes an optional `p_review_id`. Only a run carries one; a member or
platform commit with a review id is refused (22023).

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
- C2's recorder applies the kernel's layering, that of `qorpera_record_action_review`
  (20260926130000:339; 20260926210000:78-100). R1 reuses that function's verdict
  on a tool call; R2 shares the same layering for change sets no tool call
  carried:
  - Ask first wins;
  - only a company Allow rule lifts a built-in check;
  - an ask becomes a deny where no card can be raised (2026-09-25 amendment,
    item 5; RUNTIME-COMPANY-FOLDER.md:244-246);
  - a deny stands for its run and conversation (item 6).

  Contract item 4: "the kernel enforces this ordering". Cards on change sets,
  member answers on folder reviews and parked proposals come with R2.
- The recorder's design is RUNTIME-COMPANY-FOLDER-C2.md: R1 records an
  approval the automatic review already gave a tool call; R2 reviews change
  sets no tool call carried.

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
    todos, connections, rules, in the order F2 fixes. Since P28 (4 October
    2026) the exact order is:
    1. `qorpera_cloud_routines`;
    2. `qorpera_runtime_agent_todos`;
    3. `qorpera_runtime_workers`;
    4. `qorpera_folder_human_task_index`;
    5. `qorpera_folder_contact_index`;
    6. the model logins, `qorpera_provider_connections`, `FOR UPDATE`;
    7. their versions, `qorpera_provider_connection_versions`, `FOR UPDATE`;
    8. the compute identities, `qorpera_member_compute_identities`,
       `FOR SHARE NOWAIT` (a busy one leaves the work for the next pass).

    Items 1 to 5 are the hook's, in `qorpera_folder_structured_lock`'s list
    order. Items 6 to 8 are the run's sponsor: the sponsor reservation
    (`qorpera_reserve_execution_sponsor_authority`) locks a login and its
    version `FOR UPDATE`, so every path that reserves takes them here, before
    ranks 6 to 9 and the conversations. On `folder-v2` that is the run
    materializer (`qorpera_folder_materialize_company`, P28).

    **Sign-ins** (P13, migration `20260930035000`): a sign-in
    (`qorpera_native_provider_login_sessions`) or an account refresh request
    (`qorpera_native_account_refresh_requests`) sits at rank 5 just before
    item 6, `FOR UPDATE`. Its own epoch trigger, its completion and its repin
    take it before the model login and the identity. A sign-in's or refresh's
    machine also takes **the identity's machine lock**, a transaction advisory
    lock rather than a row, after rank 1 and before the sign-in:
    `pg_advisory_xact_lock(hashtextextended('qorpera.identity-machine:' ||
    <compute identity id>::text, 0))`. It keeps two machines of one identity
    (one disk) apart, which the gc fence did before. A run's own machine
    reservation takes the same lock, with the same key, when it leaves the gc
    fence (C1c-3n).

    One exception, which identity recovery (P13's second part) must respect:
    a new sign-in's insert takes the identity `FOR SHARE` (its epoch trigger)
    and then cancels the requester's earlier pending sign-ins of that identity
    (`qorpera_supersede_member_provider_logins`), so it takes those sign-ins
    after the identity. A path that holds a sign-in and then waits for the
    identity in a mode that conflicts with `FOR SHARE` (`FOR NO KEY UPDATE`,
    `FOR UPDATE`) must not hold an earlier pending sign-in of the same user.
- **Keys.** A uuid table's key is the uuid as text (resources, grants,
  rooms, routines). Keys with no single uuid are encoded:
  - members: `profile_id:user_id`;
  - staff and execution authorities: `profile_id:staff_agent_id`;
  - room members: `room_id:principal_kind:principal_id`. Sorted with
    `collate "C"`, this orders by room, then kind, then id, which is today's
    order (20260920030500:52).

  F2's claim keys keep F2's encoding.

**Who locks what.** `qorpera_folder_lock_commit_rank` locks the commit's
ranks (1, 3, 6, 7): members, execution authorities, resources (ancestors
first, by folder key) and grants.
- A hook target at those ranks is merged into that pass, never dropped.
- A target of any other table at a commit rank is a defect (XX000).
- A row the commit relies on (its member or requester, the run's agent, the
  wake's room, room members or routine) is marked `required`, and a missing
  one refuses the commit (42501).
- F2's targets carry no `required` flag; the hook checks the rows it relies
  on in `decide`.

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
  - a read-access in-house worker writes nothing, and a write-access one
    writes as its agent;
  - a coding session saves under `code/` and on an ordinary shared path, is
    denied under `agents` and `rules`, and can copy a file out of `agents/`;
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

## C1b-2

C1b-2 adds the three things that make an agent's authority hold past the
moment of its check:
- authority changes that are ordered with every commit;
- read sets, so that a read never carries past a narrowing, revocation or
  expiry;
- agent wakes, whose check needs the parent run's reads.

Coding and worker runs arrive with the agent wakes.

Built in `20260928249000_folder_core_authority.sql`, with tests 634 and 635.
It sorts after v146's activation (20260928244000) and S2's 20260928230000
and 20260928231000, whose rules for who pays it ports (§4).

### 1. Authority changes go through the clock

**What changed from core §4.** Core §4 had commits and effects hold their
covering resources and grants `FOR SHARE`, and a narrowing take them `FOR NO
KEY UPDATE`. PostgreSQL grants a new shared locker even while an exclusive one
waits (C1b-1 design review, finding 7). So a steady stream of commits and
effects on the root resource, which covers almost everything, could make a
revocation wait forever. C1b-2 orders authority changes through the clock
instead. The clock is an exclusive row lock: nothing is admitted ahead of a
waiting change as a rule, the way new shared lockers are. When the holder ends,
PostgreSQL wakes the change together with the commits waiting for the clock
(each commit already holds the clock row `KEY SHARE` through its foreign keys,
so it waits on the holder directly rather than behind the change), and one of
them takes it. Either order is correct, because the journal orders them. A
change waits at most a few commit tails in expectation.

- **Every authority change takes the clock.** A folder-v2 resource or grant
  change (§2):
  1. locks the rows it changes `FOR NO KEY UPDATE`, and the covering parent
     when it narrows, at ranks 6 and 7;
  2. bumps their revisions;
  3. takes the company clock last and writes a journal row of kind
     `authority`. The row's `authority` column holds the actor, whether the
     change narrows, and each changed resource or grant with its new revision
     and the key prefix it affects.
- **A commit that saves checks the journal after its own clock.** This holds
  for every actor: members, runs, and later views. The platform needs no
  check.
  - At its start, before it decides any unit, the commit reads `last_seq`
    with a plain read (`as_of`) and records it on the commit row.
  - It then locks the clock row (`FOR NO KEY UPDATE`) and, while it holds
    it, looks for a narrowing `authority` row after `as_of`. It increments
    the clock only when there is none, so a refused commit leaves no updater
    on the clock row, which every commit holds `KEY SHARE` through its foreign
    keys (implementation review r1, finding 5).
    - If one exists, a narrowing committed while this change set was being
      decided. The commit refuses with the QRC01 envelope (409, code
      `folder_authority_changed`). The caller retries with the same operation
      key: the refused attempt rolled back its claim. The runtime and the
      folder service retry at most three times. The envelope is not 55P03,
      which C1a's path lock and every NOWAIT also raise.
    - A change still in flight cannot commit before this one, because it
      needs the clock this commit holds. So it is ordered after, and journal
      order is authority order.
  - A widening is journaled but aborts nothing.
  - A commit that saves nothing takes no clock and changed nothing. C2's
    parking re-checks when it applies a parked unit.
- **Commits no longer lock covering resources.** C1b-1's rank-6 `FOR SHARE`
  on covering resources goes away. A hook target at rank 6 or 7 is accepted
  in `KEY SHARE` only: a shared lock on the root would bring back the
  starvation.
- **Effects that take no clock** (sends, model requests, wakes across agents;
  they are wired in C1c) use the recheck (§3), with plain reads.
  - A change that commits just after the recheck is ordered after the effect:
    the effect ran under authority that was valid when it ran.
- **What the clock does not order.** Principal changes that write no resource
  or grant are checked at the effect itself, as C1b-1 already does: member
  role and removal, staff archive. Grant expiry is checked by the recheck
  (§3). The default-agent-grant triggers widen without a journal row. That is
  harmless, since widening aborts nothing. But C2's converge worker must write
  any grant it narrows through §2.

**Revisions.**
- `qorpera_company_path_resources.authority_revision bigint not null default
  1`: the structural revision. It is bumped when the resource's scope, policy
  or match changes, when it is revoked, and when a narrower resource is
  inserted under it (the parent's revision).
- `qorpera_company_path_grants.revision bigint not null default 1`: bumped
  when the grant is revoked, or replaced by a narrower one (§2).
- **Folder mutators never bump `version`.** It is the key grants are stored
  under, and bumping it would drop every explicit grant. Revisions carry the
  change instead.

### 2. Folder resource and grant mutators

Folder-v2 companies get their own mutators. The old ones reach folder-v2 only
through `qorpera_company_path_actor`, which refuses there.

**Who may change what.** Today's rules for private resources are ported
(20260828005000:601-680). An owner or admin cannot supply a member's privacy
consent (contract 4.3).

| Resource | Create or change | Grant and revoke |
| --- | --- | --- |
| at or under a member's `members/<id>/private` | that member only, and only as `member_private` owned by them | that member only, and only to agents (`staff_agent` principals). A member-principal grant is refused |
| the root and `rules/` (seeded) | nobody: they are fixed. No resource is made at or under `rules/` | no grant on `rules/` (its `company_rules` scope decides); neither is revoked |
| any other | owners and admins; every scope but `member_private` has no owner | owners and admins |

The `protected` policy is refused (0A000) until C2 enforces it; today no
folder-v2 path reads `policy`.

**The functions:**
- `qorpera_folder_set_resource(env, actor, path, match, scope, policy)`
  creates or changes a resource, and its owner is always the actor for
  `member_private`. A resource keeps its spelling. What counts as narrowing:
  - a new narrower resource bumps its covering parent;
  - a change of match also bumps the covering parent, with the resource's
    key as prefix: paths move between the parent and the resource
    (implementation review r1, finding 1);
  - a change of match, scope or policy bumps the resource itself.

  The covering parent is the nearest `subtree` resource at a proper ancestor
  of the key, the root included (`qorpera_folder_parent_resource`).

  Clearing `revoked_at` (a revoked resource set again) is a widening.
- `qorpera_folder_grant(env, actor, resource_id, principal_kind,
  principal_id, permissions, expires_at)` inserts a grant at the resource's
  current `version`. Grants add up, so a narrower grant *replaces* the
  principal's live grant: the old one is revoked and its revision bumped, in
  the same transaction.
- `qorpera_folder_revoke(env, actor, resource_id or grant_id)` sets
  `revoked_at` and bumps the revision.

**Order.**
1. The member actor, `KEY SHARE` (rank 1). A grant also locks its principal
   `KEY SHARE`: a member at rank 1, an agent at rank 2.
2. The resource rows, `FOR NO KEY UPDATE` (rank 6): the covering parent,
   then the changed one. When nothing covers the key (a tie above it), the
   root instead, so two calls on one key always take turns. A grant or revoke
   locks its resource this way too, so changes to one resource and its grants
   take turns.
3. The tie check, in a new statement after the parent lock. A resource that
   would share a folder key with another is refused, including one made while
   this call waited for the parent (the first one wins). Then, for a new
   resource or a change of match, the parent again: if a narrower resource
   now covers the key, its paths are the ones that move, and it is not
   locked. The call refuses with the QRC01
   envelope (`folder_authority_changed`) and the caller retries.
4. Grants (rank 7), read in a new statement after the resource lock, so a
   replacement sees the grant a concurrent one made.
5. The clock, with one journal row per call. The row names the actor, and
   whether the change narrows.

**Seeded bases.** The root and `rules/` exist already (C1a, C1b-1). The code
rules (notebook, worker and todo, hiring) follow agent folders by id and come
with C2.

### 3. Read receipts, read sets and read records

**Reads stay pure.** `read` and `list` write nothing and lock nothing, as in
C1b-1. For a run, each entry they return carries the authority it was read
under, as a receipt:

```
authority: {resourceId, resourceRevision, grantId, grantRevision}
```

`grantId` is the agent's grant that allowed the read. It is null when the
agent's permission came from a scope rule, such as `rules/`.

**A release records them.** Whoever releases output to the model calls:

```
qorpera_folder_record_release(env, run actor, release_id, reads, output_sha256)
```

The caller is the runtime, per model request (C3). For the shell box, the
folder service reports the command's reads to the runtime, which releases
them at command end.

The call:
1. runs the full run check: pause, job `KEY SHARE`, fence, pause re-read, the
   run's principals and its wake;
2. for each (resource, grant) in the receipts, checks that (a receipt is the
   caller's word, so nothing else is taken from it; implementation review r1,
   finding 3):
   - the receipt's resource is each of its paths' covering resource now;
   - the revisions are unchanged;
   - the grant is null only on `rules/`, whose scope lets agents read.
     Otherwise it is a live, unexpired `read` grant of this run's agent on
     this resource at its current `version`.

   Where any of that fails, it re-resolves those paths for the run now, and
   refuses the whole release (42501) if any path is no longer readable. The
   check and the new receipt are taken in one statement: the receipt reads
   the statement's snapshot, and the check reads that one or a newer one (a
   legacy helper it calls is volatile). So the receipt is never newer than
   the check, and a narrowing between them shows as changed at the next
   recheck (finding 4);
3. writes the read set: for every (resource, grant) that covers a released
   path, it upserts one row keeping `least(recorded, observed)`. That is the
   receipt's pair when it passed, or the pair found by re-resolution when it
   did not. A stale receipt never recreates a dead row. Rows are taken in `(resource_id, grant_id)`
   order at rank 10, after rank 9, so a run's parallel effects never
   deadlock on them;
4. inserts one read-record row per (release, resource). Each row holds the
   sorted reads (path key, path, version, content hash, range or page) with
   their receipts, plus the output digest. Version and content hash are the
   caller's audit data (contract 9.1), not authority: nothing is decided on
   them.

A release id is used once. A replay with the same content returns the stored
result; a replay with different content raises 22023. The id is claimed
first, after the pause check, as a commit claims its operation key, so a
concurrent release of the same id waits and then replays.

**Tables.**
- `qorpera_folder_run_reads (run_id, resource_id, grant_id, resource_revision,
  grant_revision)`: the read set, a few rows per run. Keyed unique on (run,
  resource, grant) with `NULLS NOT DISTINCT`, since `grant_id` may be null.
- `qorpera_folder_authority_changes (environment_id, seq, resource_id,
  grant_id, revision, prefix, narrowing)`: one row per change, next to its
  journal row, indexed by (environment, resource, revision).
- `qorpera_folder_run_read_records (run_id, release_id, resource_id, reads,
  output_sha256, created_at)`: written once.
- Neither has a foreign key to runs, like the operation keys.

**The recheck.** `qorpera_folder_run_reads_current(env, profile, run
actor)`, for effects:
1. It reads each read-set row's current revisions, and whether its grant is
   expired, revoked or missing. It captures these values before doing
   anything else.
2. A row passes when the revisions match and the grant is live. A row with
   no grant is right only on `rules/`; anywhere else it is treated as changed,
   re-resolved and deleted.
3. For a row that changed, it finds the key prefixes that changed:
   - a changed resource revision: from `qorpera_folder_authority_changes`
     (environment, resource, revision, prefix; indexed), for the revisions
     after the recorded one;
   - a changed or dead grant: every path the row covers, which is also the
     case for a grant that disappeared by cascade. It then re-resolves, for the
   run's current authority, only the paths under those prefixes. It looks the
   paths up by key across all of the run's read records, not by the resource
   they were filed under.
   - An expired grant re-resolves every path the row covers.
   - It refuses (42501) if any path is no longer readable.
   - Each path's check and its new receipt are taken in one statement.
4. For every (resource, grant) that now covers a re-resolved path, it upserts
   a read-set row with the captured current revisions, keeping `least()`. So
   a narrower resource found now is watched from then on.
5. Only then does it re-stamp the changed row, as a compare-and-set that
   writes the revisions captured in step 1, never values re-read afterwards.
   If another release lowered the row meanwhile, the re-stamp does nothing,
   and the next effect re-resolves again.
   - A row whose grant is dead (expired, revoked or missing) is deleted by
     compare-and-set instead, once its paths re-resolved under their current
     authority. So an expired grant costs one re-resolution, not one per
     effect.

**The run commit calls the recheck** at step 4, after the rank locks and
before the paths. A narrowing that commits after the recheck is caught by the
journal check after the clock (§1), and the commit is retried.

### 4. Agent wakes, coding and worker runs

**Accepted wakes.** Agent wakes from coworker messages, worker dispatch and
worker completion. They are ported from `qorpera_wake_authorized`'s agent
branch as S2 left it (20260928230000 "the member who started the work pays",
20260928231000 "a member's pinned login follows them"), without its locks. The
migration sorts after both (20260928249000):

| Check | Rows locked |
| --- | --- |
| Every wake kind: the wake's login pays for work its requester started (`qorpera_sponsor_serves_requester`) | none |
| Agent wakes need no standing execution authority since S2. A coding worker's dispatch is paid by its owner's login, or the login that one follows to (`qorpera_sponsor_version_follows`), and its owner is a member | none |
| The parent run is in this company and environment | none |
| **The parent's reads:** for each row of the parent's read set, the recipient can read that resource, under the company-audience rule: not `member_private`, and both the requester and the recipient agent read it. Paths are re-resolved only for rows whose revisions changed, or whose grant expired, since the parent recorded them | none |
| Ancestry: `qorpera_coworker_wake_ancestry` or `qorpera_worker_wake_ancestry`, which lock nothing and write nothing | none |
| Worker-completion session variant (20260922170000:277-280) | none |

- **The parent's reads, before C3.** Parents have read sets only once C3
  gives agents real reads. Until then, a parent with an empty read set passes
  this check vacuously. That is exact, because it read nothing through the
  folder core.
- **Coding runs** (worker species `coding`) get session kind `coding`: the
  coding rule, and never reviewed.
  - A coding session acts for its owner (F3, #432). S2 makes the owner and the
    requester the same member for new coding work; a coding run whose worker
    owner is not its requester is still refused (42501).
- **In-house worker runs** get the access rule. Both rules are already in
  C1b-1 and tested there.
- **Still refused (0A000):**
  - office-activation and machine-event wakes, which come with C1b-3
    (computers and machines): the waiter check locks the profile row;
  - routine wakes from a file change, which come with C4 (file events from
    the journal).
- **Coworker message counters** (hop count, 20 per pair per hour) belong to
  the send path, which C1c branches.

### 5. Tests (C1b-2)

- **Authority through the clock:**
  - A narrowing that commits while a commit is deciding refuses that commit
    with `folder_authority_changed`, for a member and for a run. A retry with
    the same operation key then saves.
  - A widening in the same window aborts nothing.
  - A revoke in flight while a commit holds the clock is ordered after it.
  - A revoke waiting on the clock is not blocked by commits in flight, and
    a commit waiting with it is ordered either way: before it, with the lower
    clock value; after it, refused (dblink).
  - A hook target at rank 6 in `FOR SHARE` is refused.
- **Mutators:**
  - owners and admins on shared resources;
  - an admin cannot create or change a resource at or under another member's
    private folder (a `protected` policy there included);
  - a concurrent tie between `Østen` and `østen` is refused once;
  - the private rules: an owner or admin cannot create, grant or revoke on
    another member's private folder; a member grant there is refused;
  - a tie refused after the parent lock;
  - revisions bumped, and the parent bumped by a narrower insert;
  - a narrower grant replaces the old one;
  - one journal row each, with the actor and no `version` change;
  - explicit grants survive.
- **Releases and the recheck:**
  - A run's read returns receipts, and a release records them.
  - A replay with the same content returns the stored result; with different
    content it raises 22023.
  - A release while paused refuses.
  - A release after a revoke or an expiry re-resolves and refuses.
  - The A1 sequence: read under the root, a narrower resource and grant,
    recheck, revoke the narrower grant, recheck again. It refuses.
  - A grant that expired since the read refuses.
  - An expired grant that was replaced re-resolves once, and its row is
    deleted.
  - A stale receipt for a dead pair does not recreate its row.
  - The B1 race: a narrowing between capture and re-stamp is not stamped as
    checked.
  - Concurrent re-stamps of one run do not deadlock.
- **Agent wakes:**
  - a coworker run saves, with no standing execution authority;
  - a wake paid by another member's login refuses;
  - a coding dispatch not paid by its owner's login refuses;
  - a parent read-set row the recipient cannot read refuses;
  - the parent check does not re-resolve unchanged rows (cost);
  - worker dispatch and completion;
  - a coding run writes `code/` and is refused under `agents/`, with no
    review;
  - a coding run whose owner is not its requester is refused;
  - an in-house read-only worker writes nothing.
- **Still refused:** office activation, machine events and file-change
  routine wakes (0A000).
- **Stress:** mutators mixed with member and run commits and releases. Check
  the invariants, and that journal order is authority order.

## C1b-3: views

A **view** is the SQL authority row for a mount: F3's "every mount is a view
with one owner". It is the one place where a save made from a machine is
checked and attributed, including a save that outlives the turn that caused
it. The facts below come from the read-only inventory of 2026-09-29
(scratchpad `reports/C1b3-inventory.md`, at master d0a746bc2 with #411,
#419 and #453 read from their branches). Design review round 1
(`reports/pr497-design-review-r1.md`) reshaped §2 to §7.

**Two slices.**
- **C1b-3a:** the table, the view actor, open, renew and close, reads and
  releases, and the commit, for the three kinds whose anchors exist on
  master: `run_box`, `computer_desktop` and `coding_session`. It also moves
  the company row ahead of the members (§4).
- **C1b-3b:** `computer_shell_command` and `test_machine`. Their anchors
  arrive with #411 and #419 (§8); C1b-3b follows those merges.

### 1. The table

`qorpera_folder_views`, one row per mount:
- `id`; `environment_id` (a foreign key to the clock, cascading) and
  `profile_id` (no foreign key to `qorpera_profiles`, so inserting a view
  never locks the company row);
- `kind`: `run_box`, `computer_desktop`, `computer_shell_command`,
  `coding_session` or `test_machine`;
- `staff_agent_id`, `member_user_id` (the member it acts for), and
  `worker_access` (`read` or `write`, from the opening run's worker, or
  null);
- the anchor (§3), in kind-specific columns that a check keeps complete:
  - run box: `run_id`, `job_id`, `runner_id` and `client_lease_id`;
  - desktop: `screen_id`, `screen_generation`, `activation_id` (the office
    activation it opened under; each boot makes a new one), and the holder
    (`holder_run_id` or `holder_user_id`);
  - coding session: `worker_id` and `attachment_token`;
  - later `shell_command_id`, `company_machine_id`, `placement_id` and
    `boot_id`;
- `node_id` and `machine_id` (the allocation it was opened on), plus
  `unsaved_since`, which the folder service reports when it renews;
- `pass_sha256`: the pass is 32 random bytes, returned once at open and
  never stored. The node checks the calling vsock CID against the view's
  machine; SQL checks the pass;
- `state` (`open` or `closed`), `lease_until` (120 s), `renewed_at`,
  `closed_at` and `close_reason` (`closed`, `superseded`, `ended`,
  `expired`).

One open view per screen, per coding session, and later per test machine:
partial unique indexes. Of two opens for the same anchor, the later one
supersedes the earlier one's new view, or meets it in the index (23505)
when there was no older view to lock; the office service retries then. The
table is revoked from every API role; only the folder core's functions write
it.

### 2. The view actor

`{kind: 'view', viewId, pass}` joins `qorpera_folder_read`, `_list`,
`_feed` (C1f), `_record_release` and `_commit`, through
`qorpera_folder_read_actor` and the commit's actor branch.
`qorpera_folder_view_resolve(env, profile, actor)` makes an early check with
plain reads, which refuses quickly:
1. the row is this company's, `open`, before `lease_until`, and the pass
   hashes to `pass_sha256`;
2. the anchor predicate (§3);
3. the principals: the agent is active and the member is still a member.

**That early check is not the guarantee.** A holder change can commit
between it and the save. The binding check is the commit's anchor step
(§4), which runs the same predicate while taking the anchor lock.

It returns a resolved actor like a run's, with `view: {id, kind,
companyWide}` added:
- **A run box** resolves to its run, as `qorpera_folder_run_resolve` does.
  The view's stored `runner_id` and `client_lease_id` must still be the
  job's, so a re-claimed lease ends the old host's view.
- **A desktop held by a live run** resolves to that run, within the
  company-wide view.
- **A desktop held by a member** resolves to that member, within the
  company-wide view. A member-held view records no reads (members have no
  read sets), and it is not stopped by the pause, as members' own saves are
  not.
- **A desktop whose run has ended, and every coding session,** resolve to a
  *detached* staff actor: `{kind: 'staff_agent', staffAgentId,
  requesterUserId, audience: company, sessionKind, workerAccess, runId:
  null}`.
  - `sessionKind` is `in_house` for a desktop and `coding` for a coding
    session.
  - `workerAccess` is the view's, so a read-only worker's programs stay
    read-only after the worker ends.
  - Coding sessions resolve detached even during a turn. The coding rule
    decides their authority, and the turn's run adds nothing to it.

**The company-wide view** is enforced in
`qorpera_folder_actor_resource_allowed`, before its early returns for member
and platform actors. An actor with `view.companyWide` may use a path only
when its covering resource is the root, or `rules/` for reads. That comes on
top of the actor's own authority, so a view can only narrow it:
- a member-held desktop never reaches the member's private folder;
- grants never inherit, so paths under any narrower resource stay out.

A company-wide view opens only when its agent and member both read the root
resource (compute amendment item 4).

### 3. Anchors and when a view is valid

The inventory's main finding: several paths that change who holds a
computer, or end an attachment, use plain UPDATEs with no row lock
(`qorpera_begin_runtime_office_lifecycle`, `qorpera_request_runtime_office_privacy`,
`qorpera_set_runtime_browser_grant`, `qorpera_archive_coding_worker`,
`qorpera_cancel_worker`). A plain UPDATE takes `FOR NO KEY UPDATE`. That
does not wait for `KEY SHARE`, but it does wait for `FOR SHARE`.

So the commit's anchor step locks the anchor `FOR SHARE`, then checks the
full predicate in a new statement, and refuses when it fails. The lock waits
for any change in flight on the anchor row. The new statement's snapshot then
sees that change, and every other table the predicate reads (access, the
activation, the coding refusal's joins). A statement that locks and checks
at once would re-check only the locked row after a lock wait (review round
2, finding 4, reproduced). A change to the anchor row that comes after the
lock waits for the save to finish (changes to other rows: §4). None of the
legacy holder-changing paths needs a patch (the only legacy change is
`screen_in_use`, §9).

| Kind | Anchor | Valid while (the predicate) |
| --- | --- | --- |
| `run_box` | the job, `KEY SHARE`, taken at step 3 as for a run | the run actor checks pass, and the job still carries the view's `runner_id` and `client_lease_id` |
| `computer_desktop` | the screen row, `FOR SHARE` | the view is the newest open view of its screen; the screen's `generation` is the view's; either the screen's drain is still pending (the old holder's final publish, whatever the privacy state), or the screen is held by the view's holder or by nobody and privacy is shared or this is the private member's view; the office's current activation is the view's; the agent's `qorpera_runtime_office_access` is active |
| `coding_session` | the session row, `FOR SHARE` | the session carries the view's `attachment_token`, and `qorpera_coding_attachment_refusal` finds nothing (not archived, not expired, repository not withdrawn, executor enabled) |
| `computer_shell_command` (C1b-3b) | the command row, `FOR SHARE` | the command has not ended (§8 has the end boundary), and the screen's `generation` and the office's current activation are unchanged |
| `test_machine` (C1b-3b) | the machine row and its current placement, `FOR SHARE` | the placement and `boot_id` are the view's |

**Desktops: the newest view wins.**
- The office service opens a new view at every change of holder: a run
  acquiring the screen, a member's takeover, a private sign-in, and every
  machine start or restart. `view_open` closes the screen's older views
  (`superseded`).
- A run's own release opens nothing, so after its run ends a desktop view
  stays valid until someone else takes the screen, and saves are credited
  to the view's agent and the run's requester (F3, #432).
- Keying on "newest view", not on the screen's holder columns:
  - ends a view at a private sign-in, where no `takeover_user_id` is set;
  - never lets an old view come back after a later holder leaves (A, B,
    then nobody).
- The holder term ends the old view at once. When another run acquires the
  screen, when a takeover's drain is acknowledged, or when a member signs in
  privately, the predicate refuses before any new view opens. So a new
  holder's saves never go through the old holder's view.
- **Another run acquiring the screen is not a drain**, so it has no end
  boundary. Changes the old holder's programs left pending publish later
  under the new holder's view. That is acceptable: a seat passes to another
  run only when the old run no longer holds it, and #409 item 1 closes the
  desktop before the seat changes hands.
- A view ends when:
  - the office stops, powers off, resumes or reboots (a new activation);
  - the seat changes agent (`generation`);
  - the agent loses computer access, which writes no screen row but is
    checked by the predicate.

**The end boundary: a final save before a takeover.** A takeover is a drain
(#411: it drains the whole computer).
- While the drain is pending, the run's view stays valid (the holder term's
  pending-drain case), so its last publish, the changes made before the
  drain, is saved and credited to the agent.
- **The node publishes those final changes before it acknowledges the
  drain.** The ack then ends the old view. The member cannot drive before the
  ack either: the viewer check refuses while `drain_pending`.
- The office service opens the member's view right after the ack. Changes
  the member makes before it opens stay pending and publish as the member.
- A stop works the same way: the node publishes before it acknowledges the
  stop, and the new activation ends the view.

### 4. Lock order

The commit, with a view actor (core §3):
1. the operation key, scoped to the view;
2. the pause check before any lock, for every view that acts as an agent;
3. for a view with a live run, the job `KEY SHARE`; then the view row
   `KEY SHARE`; then the folder fence `KEY SHARE`, and the pause re-read.
   The view resolves again here. If it now acts through a run it held no job
   lock for (it was detached at step 2, and the holder came back in
   between), it refuses as retryable (409 `folder_view_changed`); the retry
   takes the job first (review r1 of the implementation, finding 3);
4. **rank 0: the company row** (`qorpera_profiles`, `KEY SHARE`), when the
   hook asks for it;
5. ranks 1 to 9, rank 10 (the read sets, §6), paths, objects, decide, apply
   and verify, as for any commit;
6. **the anchor step**: lock the anchor `FOR SHARE`, then re-check the full
   predicate of §3 in a new statement, and refuse (rolling the commit back)
   when it fails;
7. admission, and the clock with its authority check (C1b-2 §1).

**The anchor step's re-check covers the anchor row's writers and any change
committed before the step.** A change to another row (computer access, an
activation, an executor, a repository grant) that commits after the check
does not wait for the save. The window runs from the check to the commit's
end, which is short, and C1b-2's clock check still orders any narrowing.

**Why the anchor comes last.**
- **No deadlock.** No legacy path locks folder rows, and every lock taken
  during apply (F2's company row, the operations clock) comes before the
  anchor. That matches the legacy orders:
  - run acquire: company row, office, screen;
  - coding attach: company row, worker, session;
  - #419: fence, machine, placement.
- **Short hold.** The anchor lock is held from just before the clock to the
  commit's end, so a large publish never makes the machine's other seats
  queue behind their office row (review finding 8).

**Why rank 0.** #462's leave, remove and role change lock the company row
`FOR UPDATE` and then the member row. A save that took the member at rank 1
and the company row at rank 2 deadlocked with them (review finding 7,
reproduced).
- The commit now takes the hook's company-row target at rank 0: after the
  job and the fence, before the members.
- The target check accepts rank 0 only for `qorpera_profiles` in `KEY SHARE`.
- F2's roster targets move from rank 2 to rank 0.
- What remains is the case already in "Notes for later slices": a run's
  commit against the removal of its own requester, where removal ends the
  job after the member. C1c resolves it.

**The company row is not taken unconditionally** (review finding 7's
starvation point). Only saves that write a row referencing the company take
it. Legacy `FOR UPDATE` on the company row (native tool calls, coding
attach, #419's two-second `fence_briefly`) waits only for those. C1c removes
those locks from folder-v2 paths before any view goes live.

**One order for a view and what it acts through: the job, then the view
row, then the fence and the principal rows (members, staff, rooms).** The
commit and the release both take them in that order. So does anything that
locks two of them more strongly, for example C3 ending a run and closing its
run box views (job `FOR UPDATE`, then the view `FOR UPDATE`), or C1c closing
a leaving member's views (the view, then the member row). Another order
deadlocks with a release or a save in flight (implementation review r3,
finding 1, and r4, finding 1, both reproduced).

Renewal takes the view `FOR NO KEY UPDATE`, which never waits for a commit's
`KEY SHARE`. Closing and superseding take it `FOR UPDATE`, which waits out
the view's commit in flight. A renewal that finds the view no longer valid
closes it under that same `FOR NO KEY UPDATE`, without waiting for the
view's commit or release in flight (decided 3 October 2026, after #714's
review asked). That work may land after the close. The next view's open is
what waits it out: it takes the machine's newest view `FOR UPDATE`, open or
closed, and carries its reads into the new view (§5; test 644 H). A run
box carries no reads, so nothing waits for its work. So a closing renewal
never stalls the folder service's renewals behind a long save. The folder service keeps one commit in flight per view.

### 5. Open, renew and close

All three are service_role functions, called by the trusted services, never
by a machine.
- **`qorpera_folder_view_open(env, opener, kind, anchor)`** returns `{viewId,
  pass}`.
  - It derives the agent, the member, `worker_access`, `node_id` and
    `machine_id` from the anchor: screen → office → current allocation →
    demand node; session → `attached_machine_id` → allocation.
  - For a desktop, the opener names the holder, which must be the current
    one: the lease's live run, the takeover member, or the private member
    signed in.
  - Order: the screen's older views `FOR UPDATE` (the open one and the
    newest, waiting out their last save and release), then the anchor `FOR
    SHARE`, then the predicate re-checked in a new statement, then the
    insert. Open records the view's `activation_id` (desktops and shell
    commands).
  - **It carries the machine's previous view's read set** into the new view:
    its pairs, and its read records merged into one record per resource (§6).
    The previous view is the newest view of the same screen or coding
    session, open or closed. It is carried only while the machine runs on: a
    desktop within one seat assignment and one power-on (the same
    `screen_generation` and `activation_id`), a coding session while it stays
    on the same machine.
  - **The caller opens a view in its own transaction, after the holder
    change has committed.** A holder change and an open in one transaction
    deadlock with a save of the old view in flight: the save holds the old
    view `KEY SHARE` and waits for the screen, and the open's transaction
    holds the screen and waits for the old view (implementation review r1,
    finding 4, reproduced). In separate transactions the save simply refuses
    ("view has ended"). The same holds for a coding attach and its open.
  - A run box's opener is the run actor, with the job `KEY SHARE` first.
- **`qorpera_folder_view_renew(viewId, pass, unsaved_since)`** re-checks the
  predicate and the principals with plain reads, and extends the lease by
  120 s. If the view is no longer valid, it closes it (`ended`, or `expired`
  when its lease lapsed) and reports that instead of raising, so the close
  stays.
- **`qorpera_folder_view_close(viewId, pass)`** closes it (`closed`).
- A replay of a view's commit or release is answered only with the view's
  pass.
- Nothing sweeps expired views: resolution refuses them, and C1d's GC marks
  them `expired`.

### 6. Reads and releases

- Reads and listings by a view acting as an agent carry receipts (C1b-2
  §3).
- **Every view release writes the view's own read set**:
  `qorpera_folder_view_reads` and `qorpera_folder_view_read_records`, keyed
  by view, with `qorpera_folder_view_releases` for release ids. With a live
  run it also writes the run's read set. So a desktop program that read a
  file during a run is still rechecked when it saves after the run ends.
- **A coding view's release, while one of its worker's turns is leased,
  also writes that turn's run read set** (review round 2, finding 3). The
  release takes the turn's job `KEY SHARE`, as `run_enter` does, so the
  turn's completion waits for releases in flight. The executor flushes the
  session's releases before it completes the turn.
  - Coding views resolve detached, so without this, coding reads would reach
    no run's set.
  - The agent-wake parent check for the worker's completion (C1b-2 §4) reads
    the parent run's set, so it would pass without checking anything.
  - Coding commits during a leased turn record the turn (`turn_run_id` on the
    commit), for attribution. Their authority is still the coding rule's,
    and `run_id` stays empty: the save acts detached.
  - **Amended by P29 (4 October 2026):** `turn_run_id` is also the causal
    parent of the wakes such a commit causes (file-change wakes,
    `RUNTIME-COMPANY-FOLDER-LISTENER.md` §5), so self-trigger fencing applies
    to it: an agent's coding save never wakes that agent, and a chain keeps
    its provenance instead of starting fresh. Nothing bounds a chain's length
    since 24 September (LISTENER §5).
- **Every view commit rechecks the view's read set at rank 10**, and one
  run's set besides (`qorpera_folder_view_reads_current`, same rules as the
  run's). The run's set is checked under that run's own authority (its
  agent, requester and audience, without the company-wide restriction),
  built from its row by `qorpera_folder_run_reader`, live or not:
  - a live run: that run;
  - **a detached desktop: its holder run.** The run's model may have typed
    what it read into the desktop, and a program may save it after the run
    lets go of the screen. The set is rechecked for the rest of the view's
    life (implementation review r1, finding 1);
  - **a coding view during a leased turn: that turn**, for the same reason.
    The executor saves the session's changes before it completes a turn, as
    it flushes its releases, so a turn's reads do not need checking after
    the turn has ended.
- **Reads follow the machine while it runs.** A new view carries its
  machine's previous view's read set and records (§5). So a program's read
  survives a holder change and a takeover, and the next view still rechecks
  it.
  - **The carry ends with the machine's run.** A restart (a new activation),
    the seat changing agent (a new generation, which closes the desktop) and a
    coding session moving to another machine all start with an empty set
    (implementation review r2, finding 1).
  - **The way out for a blocked machine.** Once a program read a file that
    has since been narrowed, every save from that machine is refused ("A read
    is no longer readable") until the machine starts clean. For a desktop
    that means restarting the computer; for a coding session, archiving it or
    moving it to another machine. C3 shows members that reason and offers the
    restart. Without the carry's end, a single narrowing would block a seat
    for good, even for the next agent on it.
  - The records carried are bounded by the reads of one run of the machine.
  What is not carried is an earlier holder run's own set: that is checked
  for the life of that run's view. Once another holder's view has opened,
  anything the old run left on the screen is the new holder's to publish,
  as with pending changes (§3). The folder cannot follow content a machine
  keeps on its own disk anyway. The recheck makes revocation take hold in
  the sessions that saw the file; it does not trace every copy.
- **Inheritance is a release into the run.**
  `qorpera_folder_run_inherit_view_reads(env, run actor, viewId,
  inherit_id)`:
  - only for a view of the run's own agent and member;
  - it runs `run_enter`, then the `record_release` checks for each of the
    view's pairs and this run's agent (§3 of C1b-2);
  - it re-resolves the view's recorded paths where a check fails, and
    refuses if one is no longer readable;
  - it copies the view's read records into the run's, so the run's recheck
    finds the paths;
  - it writes at rank 10 and is idempotent per `inherit_id`.

  The runtime calls it when a run takes in a view's output (C3 wires it).
  This is how "that next run inherits them" (F3, #432) happens: at the
  moment the output reaches a model.
- **A view release locks in the commit's order**: a plain resolve; the job
  of the run it acts or reads through (`KEY SHARE`); the view row `KEY
  SHARE`; the resolve again, refusing as retryable (409 `folder_view_changed`)
  if the view now names a run whose job it does not hold; then the run check
  with its fence and principal rows (`run_enter`). An open superseding the view (`FOR UPDATE`) either finishes first,
  and the release then refuses, or waits for the release and carries its
  reads (implementation review r2, finding 2; r3, finding 1).
- **Feed pages** carry no receipts and only invalidate (agreed with F3 on
  #444).

### 7. The commit and attribution

- `qorpera_folder_commits` gains `view_id` and `view_kind`.
  `qorpera_folder_commits_run_attribution` is relaxed: a staff actor without
  a run is allowed when `view_id` is set.
- **A view resolving to a live run** carries that run's review id, as the
  run's own commits do (a desktop delete is reviewed through its holder's
  run).
- **A detached view's unit that needs the automatic review** gets the outcome
  `review_required`, as a run's unit without a review does today. Parking
  it until the agent's next turn for the same member is C2's.
- The authority check after the clock (C1b-2 §1) covers every view: none is
  the platform.

### 8. C1b-3b: shell commands and test machines

- **`computer_shell_command` needs a row per command.** #411's session builds
  it in a follow-up stacked on #411 (agreed 2026-09-29). Today the run →
  command link lives only in guest memory, keyed by the start receipt, and
  #411's `qorpera_runtime_office_shell_activity` is one row per screen that
  names no command. `qorpera_runtime_office_shell_commands`:
  - `id` = the start effect's receipt, and `command_id` = the guest's session
    id;
  - `office_id`, `screen_id`, the screen `generation`, `run_id`,
    `staff_agent_id` and `requested_by_user_id` (from the run);
  - `started_at`, then `ended_at` and `end_reason` (`exited`, `stopped`,
    `drained`, `paused`, `lost`).

  It is inserted with the start effect, under the office and screen locks
  that path already takes. It is ended by the guest's report, or by a drain
  of its screen.
  - **Until each command has its own mount namespace** (F3's step 4), the
    report ends a command when its process group is empty. Programs that
    leave the group (setsid, daemons) are not caught yet.
  - **From then on,** the report ends a command when no process is left in
    the command's mount namespace. The row does not change.

  The per-screen activity row stays the awake and seat signal.
- **The end boundary for commands and test machines** (review round 2,
  finding 5):
  - a drain or a normal exit records `end_reason`, but the view stays valid
    for one final publish;
  - that publish carries `final`, and the commit closes the view in the same
    transaction;
  - a test machine's "command not ended" check accepts a publish made at
    that command's end.
- **Takeover drains the whole computer** (#411), so it ends the agent's
  commands. The folder design says so.
- **Findings sent to #411's session on 2026-09-29.** The first was a real
  bug, fixed in #411 at 3822194a1 (migration 20260929070200): the new shell
  arguments were refused by the live `qorpera_native_office_operation`. The
  second is that a takeover ends the command. #411's session keeps that,
  because a command left running could still use the screen the member now
  controls.
- **`test_machine`: the view is anchored on the machine row and its current
  placement.** There is one open view per machine. It is owned by the
  starter's run: the lease, and what is visible.
  - A publish names the commands running while its changes were made. SQL
    checks them against `qorpera_company_machine_commands` (that machine,
    that placement, not ended).
  - **Authority when commands overlap:** the units must be allowed for every
    credited command's agent. The commit's actor is the command that
    started first, and `credits` lists all of them. With no command
    running, the starter is credited.
  - The machines session adds `requested_by_user_id` to command rows (or
    C1b-3b does, if it lands first).
  - The machines' end paths need no change: they update the machine and
    placement rows, which wait for the anchor step's `FOR SHARE`.

### 9. What others need

- **S3's drain read** (`qorpera_runtime_node_drain_status`) reads no view
  today. Once C1b-3a lands, it counts open views on the node with
  `unsaved_since` set, as a reason not to restart.
- **Seat recycling** (`take_seat`, through
  `qorpera_runtime_office_screen_in_use`) does not yet count a screen as in
  use while its open desktop view has unsaved changes. C1b-3a adds that
  condition to `screen_in_use`, so a seat with unsaved work is not
  recycled. `unsaved_since` is up to one renewal (40 s) stale; the folder
  service also renews early when a mount first gets unsaved changes.
- **F2's roster targets** move to rank 0 (§4), in C1b-3a's migration:
  - a text patch of `qorpera_folder_structured_targets` that requires exactly
    its four rank-2 company-row sites;
  - F2's tests that assert rank 2 (700, 702, 706) change in the same PR;
  - the commit refuses `qorpera_profiles` at any rank but 0, so an old copy of
    the function re-created later fails loudly instead of bringing back the
    #462 deadlock;
  - core §3 step 4 says rank 0.

  The rank-0 lock is taken only when a target asks for it, so every F2 apply
  path that inserts a row referencing the company must declare it. The one
  undeclared insert found is a vision save's first
  `qorpera_folder_company_index` row. In practice that is the platform's
  creation commit, which takes no member lock; F2 declares rank 0 for vision
  saves in a follow-up. C1b-3a's test checks each roster kind's lock order
  (review round 2, finding 6).
- **C1c** removes legacy company-row `FOR UPDATE` from folder-v2 paths before
  any view goes live, and resolves a run's commit against its own
  requester's removal.

### 10. Tests (C1b-3a)

- **Open, renew and close** for each of the three kinds. A bad pass, an
  expired lease and a closed or superseded view are refused. Open derives
  the agent, member, node and machine, and refuses a holder that is not
  current.
- **The company-wide view:**
  - a desktop view reads and writes root-covered paths and reads `rules/`;
  - it is refused under a narrower resource, even where its agent holds a
    grant;
  - a member-held view never reaches the member's private folder;
  - it refuses to open without the agent's and the member's root read.
- **Validity:** another run's acquire, a takeover after its ack, a private
  sign-in, a seat changing agent, an office restart, and revoked computer
  access each end a desktop view. No old view comes back after a later
  holder leaves. A coding archive and a lapsed attachment end a coding
  view. A re-claimed lease ends a run box view.
- **The anchor step:**
  - a holder change that commits between resolve and the anchor step
    refuses the save;
  - a dblink race shows each plain UPDATE (the office lifecycle, privacy,
    the coding archive) waiting for a save in flight, and the save after it
    refused.
- **The end boundary:** during a takeover's pending drain, the run's view
  makes its final save, credited to the agent. After the ack it refuses, and
  the member's view opens. Another run's acquire and a private sign-in
  refuse the old view before any new view opens.
- **Activations:** a power-off, resume and reboot each end a desktop view.
- **Coding reads** during a leased turn land in the turn's run set, and the
  worker completion's parent check sees them.
- **The anchor step after a lock wait:** a revocation of computer access that
  commits while the save waits for the screen lock is seen, and the save is
  refused.
- **Detached saves** keep `workerAccess`. A unit needing review returns
  `review_required`.
- **Reads:** every view release writes the view's set, and a live run's too.
  A detached view's save after a narrowing of a file read during the run is
  refused. Inheritance re-checks for the run's agent and copies the records,
  so the run's later recheck catches a narrowing.
- **Rank 0:** with a hook that names the company row (as F2's roster files
  do), a member's save and a view's save never deadlock with
  `qorpera_update_profile_member_role`, which takes the company row and then
  the member row, like `qorpera_remove_profile_member` (dblink, both
  orders). A third connection holds the member row `FOR KEY SHARE`, which
  stops the role change between its two locks but still lets a save take
  the member row. So with the company row after the member, the test hits a
  real deadlock (checked by swapping the two lock calls).

## Not in C1b

- Real runs on folder-v2 companies: C3 and C4.
- Effects' folder-v2 branches (sends, completion, context views, coworker
  messages) and the old writers' refusals: C1c.
- Moving job renewal to `FOR NO KEY UPDATE`. It is a branch on the company's
  core inside a runner RPC, and it only matters once folder-v2 runs exist, so
  it lands with the first real runs (C3). Until then renewal's `FOR UPDATE`
  only waits for commits, which are short.
- Cards, member answers and parked proposals: C2.

## Notes for later slices

- **C1c's per-caller list** includes `qorpera_remove_profile_member` and
  `qorpera_leave_hosted_profile`. They lock the member row `FOR UPDATE`, and
  their triggers then terminalize the runs the member's connections sponsor
  (job `FOR UPDATE`). A run commit takes the job first and the member after,
  so a member removed during their own run's commit can deadlock (40P01)
  until those paths take the job first.
- **C1b-3** relaxes `qorpera_folder_commits_run_attribution`: a view's save
  after its turn has an agent actor and no live run.
- **Savepoints around folder commits.** A stress run that wrapped each
  commit in a PL/pgSQL exception block hit PostgreSQL 17.6's internal error
  "new multixact has more than one updating member". The cause (review r1,
  finding 5): a commit refused by the authority check had already updated the
  clock row, which every commit holds `KEY SHARE` through its foreign keys,
  so each refusal left an aborted updater on it. The commit now increments the
  clock only after the check passes. Callers should still retry a refused
  commit in a new transaction, as the runtime does.
- **C1e: authority-change latency.** Measured in review r1: a grant took
  13 ms at p50, 108 ms at p95 and 343 ms at most while 16 clients committed
  without pause (3.8 ms idle). C1e adds revoke latency to its pass criteria,
  and the latency of a release of thousands of paths, which now resolves each
  path once, against the 4-second result fence.
  If the tail grows at 32 to 64 clients, point the folder tables' foreign
  keys at a dedicated anchor row that is never locked exclusively, not at
  `qorpera_company_files` (its upload quota trigger locks that row
  `FOR UPDATE`).
- **C1e, P24b (migration 20260930019500, test 839): a read set is re-resolved
  set-based.** The load test found re-checking a read set after a re-grant
  quadratic: each path was re-resolved one by one (its covering resource
  looked up against every resource, twice) and each receipt appended with
  `jsonb ||` in a loop. A run that read 25,000 paths took 252 s for one
  re-check, so under the 8 s statement timeout it could never make another
  model request. `qorpera_folder_paths_resources` (the covering resource of
  many valid paths in one hash join) and `qorpera_folder_paths_authority`
  (each path's check and receipt in one statement, decided once per
  resource) serve the run and view re-checks, a release's pairs and an agent
  wake's parent-reads check. **The covering rule now has two copies:** any
  change to `qorpera_folder_path_resource` (C2's code rules, for example)
  must change `qorpera_folder_paths_resources` too; 839 A checks they agree.
- **Runbook, after a PostgreSQL major upgrade** (or any change to
  `qorpera_folder_key`): besides recomputing stored keys (core §2), run
  `REINDEX INDEX qorpera_company_path_resources_folder_key`. An `update …
  set path = path` can be a HOT update and write no new index entry.
