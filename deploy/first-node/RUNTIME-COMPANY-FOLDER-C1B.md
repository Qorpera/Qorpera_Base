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

- **Binding fields.** `jobId`, `runnerId` and `assignmentId` prove the caller
  holds the run's current job lease. They are checked against the job row.
  They are not part of the operation key's digest (§4).
- **The caller** is service_role, as in C1a: the runtime, or the node's
  folder service.

### 2. The run check

Order, extending core §3 steps 1–5. "Plain" means a plain read:

| Step | What | Lock | Refused when |
| --- | --- | --- | --- |
| 0 | the pause | plain | the company is paused (55000). An effect refuses before it locks anything, so stop never queues behind new effects |
| 1 | the operation key | claim | a replay returns the stored outcomes |
| 2 | the job, by `jobId` and `runId` | `FOR KEY SHARE` | not `leased`; another runner or assignment; `lease_expires_at <= clock_timestamp()` (42501) |
| 2 | the run | plain | another environment; `source_kind = 'proposal_review'`; past its deadline (42501) |
| 3 | the folder fence | `FOR KEY SHARE`, then re-read the pause | paused (55000) |
| 4.1 | members: the requester | `FOR KEY SHARE` | not a member (42501) |
| 4.2 | staff: the run's agent | `FOR KEY SHARE`, through the hook's lock (§8) | not `active`, or `version < run.staff_version` (42501) |
| 4.4, 4.5 | the run's wake | `FOR KEY SHARE`, at its rank | not authorized for its kind (below) |
| 4.6 | covering resources | `FOR SHARE`, as C1a | – |
| 5 on | paths, objects, clock | as C1a | – |

**The run's wake.** It is found by `qorpera_wake_occurrences.run_id`, which is
unique. Checks by kind:

| Kind | Checks | Rows locked |
| --- | --- | --- |
| human, first-run | the session is open, in this company, bound to this agent | none beyond 4.1 and 4.2 |
| routine | the routine is active, or concluded by this run; its current version, or the run is live and the current version has the same agent; the version's creator is the requester | the routine, rank 5, `KEY SHARE` |
| room | the room is active; the agent and the poster are active room members; the input is in the room | the room, then its two members, rank 4, `KEY SHARE` |
| agent (coworker, worker dispatch and completion, office activation, machine event) | refused with 0A000 until C1b-2 | – |

- **Agent wakes wait for C1b-2.** Their check includes "every path the parent
  run read is readable by this agent". On the folder core that is a check
  against the parent's read records, which C1b-2 builds.
- **What the run check does not require:**
  - The native provider lease. A save may land in the gap between the native
    lease's release and the job's completion (inventory point 3). The job
    lease is the run's liveness: every change that ends it takes the job
    `FOR UPDATE`, and so waits out commits in flight.
  - Sponsor and compute availability. They govern model requests, not file
    saves. `qorpera_execution_sponsor_available` is false once the job ends
    anyway, and it locks provider connections outside the rank order.
- **`KEY SHARE` on members, staff, routines and rooms** does not block a plain
  status UPDATE: archive, role change, routine expiry. An effect that checked
  "active" and commits after the archive is ordered before it. That is the
  same outcome as today, where the archive waits for effects in flight and
  then applies.
- **Session kind.** It is read from `qorpera_run_worker(run)`: `species`
  'coding' is a coding session, and anything else is in-house. A coding run
  gets the coding path rule (§3) and is never reviewed (§6).

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
  - any other audience: refused. Today's `human` audience exists only for
    the approved-actor substitution, which the design forbids (core §3
    step 2).
- A coding run also has `agents/**` and `rules/**` read-only (contract 5.6).
- A subtree unit checks the same boundaries as C1a
  (`qorpera_folder_member_keys_allowed`). It checks both principals, at each
  boundary.

**Explicit bases in C1b-1:**

- **`rules/`.** `qorpera_folder_enable` seeds a `rules` resource with a new
  scope, `company_rules`:
  - every member reads it, and owners and admins write it;
  - an active agent reads it, and no agent writes it.

  `qorpera_folder_principal_allowed` wraps the shared principal check and
  handles this scope. The resources scope check gains the value, and
  snapshot-v1 never uses it.
- **Members' private folders.** They stay implicit, as today and as in C1a.
- **The code rules** (notebook, worker and todo, hiring) follow the agent's
  folder by id, which needs the `agent.md` index. They come with C2.

**The indexed resolver.** `qorpera_folder_path_resource` looks resources up
with an expression index on `(environment_id, qorpera_folder_key(path))`,
against the key's ancestors (`= any(prefixes)`). That is at most one index
probe per path level, in place of C1a's scan of the company's resources. A tie
between two resources that share a folder key still covers nothing (C1a).
C1b-2's mutators refuse to create one.

### 4. Operation keys

- **Scope.** `qorpera_folder_operation_keys` gains `scope_id`: the run's id
  for a run, the view's id for a view (C1b-3), and a fixed nil uuid for
  members and the platform. The primary key becomes `(environment_id,
  scope_id, operation_key)`.
- **Digest.** The request digest leaves out the binding. It covers `{kind,
  runId}` for a run, and `{kind, viewId}` for a view. So a replay after a lease
  re-claim returns the stored outcomes, and two runs that pick the same key
  no longer collide.

### 5. Attribution

`qorpera_folder_commits` records:
- for a run: `actor_kind = 'staff_agent'`, `actor_id` = the agent, the
  requester, `run_id` and `causal_wake_id`;
- new columns: `session_kind` ('in_house' or 'coding'), `routine_id` and
  `routine_version` (a routine wake), `audience_kind` and `audience_user_id`,
  and `review_id` (§6).

### 6. Review in SQL

**Classes, per unit** (core §4):

| Actor | Class |
| --- | --- |
| member, platform, coding run | plain |
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
| absent, or bound to another run, digest or unit set | `denied` |
| `deny`, or answered `deny` | `denied` |
| `ask`, not yet answered | `waiting_for_review`. Not applied; C2 parks the unit as a proposal |
| `allow`, or answered `allow` | the unit is decided as usual |

- **Locking.** The review row is taken `FOR KEY SHARE` at a new rank
  between grants (7) and vault rows (8), written 7b. Answering takes it
  `FOR NO KEY UPDATE`.
- **In C1b-1**, the runtime reviewer records reviews through a
  service-role function. Cards, member answers and parked proposals come with
  C2, which owns proposals.

### 7. The folder pause

Stop is two phases (core §9), in two transactions:
1. `qorpera_folder_pause(profile, reason)` commits the pause row. New effects
   refuse at step 0 without locking anything.
2. `qorpera_folder_pause_drain(profile)` takes the folder fence `FOR UPDATE`,
   which waits out the effects in flight, and bumps its revision.

Resume is one transaction: the fence `FOR UPDATE`, delete the pause row, bump
the revision. Both functions are operator-only, like today's pause. Today's
`qorpera_set_company_execution_pause` takes the profile row `FOR UPDATE`, so
it refuses folder-v2 companies. That refusal is part of C1c's per-caller
decisions.

### 8. The structured-file hook

C1b-1 adds F2's six functions with the signatures agreed on #408 (comment
of 2026-09-28 07:07Z), and calls them from the commit:

| Step | Call |
| --- | --- |
| 4, before any lock | `qorpera_folder_structured_targets(env, actor, units)` |
| 4, per range | `qorpera_folder_structured_lock(env, targets, from_rank, to_rank)` for ranks 2, 4–5 and 8–9. The commit locks ranks 1, 3, 6 and 7 itself, and merges in any hook targets that name rows of its own tables |
| 7, per unit | `qorpera_folder_structured_decide(env, actor, commit, unit_no, unit, eff_path, eff_to)`, after the generic checks |
| 7, per unit | `qorpera_folder_structured_review_class(env, actor, unit, eff_path, eff_to)` |
| 8, per clean unit | `qorpera_folder_structured_apply(env, commit, unit_no, unit, eff_path, eff_to)` |
| 9 | `qorpera_folder_structured_verify(env, commit)` |

**Stubs.**
- `targets` returns no rows.
- `decide` returns `{ok: true}`.
- `review_class` returns `plain`.
- `apply` and `verify` do nothing.
- `lock` really locks the targets it is given, in `(rank, table, key)` order
  and in each target's mode, for the tables the run check needs:
  `qorpera_profile_staff`, `qorpera_company_rooms`,
  `qorpera_company_room_members` and `qorpera_cloud_routines`. The commit
  passes its own staff, room and routine rows through it, so each table stays
  locked in one key order. F2's version keeps locking every target it is
  passed, whatever table it is in.

### 9. Tests (C1b-1)

- **The run check.** Hand-built job, run, wake, session, routine and room
  rows. A leased run saves. Refused with 42501, and nothing applied:
  - a job not leased, expired, or re-claimed by another runner;
  - the wrong environment;
  - staff archived, or the requester not a member;
  - a routine paused, or a room member removed.
  An agent wake is refused with 0A000. A paused company is refused with
  55000 before any lock.
- **Authority.** Audience company against a member-private resource; audience
  member_private for another member; `rules/` (a contributor, an agent and a
  coding run denied; an owner saved); the coding rule on `agents/**`.
- **Operation keys.** A replay after a lease re-claim returns the stored
  outcomes; two runs using one key each save.
- **Review.** A delete by an in-house run: denied with no record, saved with
  `allow`, `waiting_for_review` with `ask`, denied with a record bound to
  another digest. A coding run's delete is plain.
- **Concurrency (dblink).**
  - A commit holding the job `KEY SHARE` makes a lease-ending `FOR UPDATE`
    wait, and a renewal at `FOR NO KEY UPDATE` does not wait.
  - Stop phase 2 waits for an in-flight commit. A commit that starts after
    phase 1 refuses without waiting.
  - Staff archive does not wait for a commit.
- **The indexed resolver.** An index probe per level: EXPLAIN in the test.

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
- **Read sets.** `qorpera_folder_run_reads`, keyed by (run, covering
  resource, agent grant), with the oldest unchecked revisions,
  `least(recorded, observed)`. Written by run reads and listings.
- **Read records.** `qorpera_folder_run_read_records`, one row per release
  (the runtime releases per model request) and covering resource. Each holds
  a sorted list of (path, version, content hash, range or page) and the
  output digest.
- **The recheck.** `qorpera_folder_run_reads_current(run)`, for effects:
  - `FOR SHARE` on the read set's resource and grant rows;
  - compare the revisions;
  - on a change, re-resolve only the paths under the changed prefix, from the
    read records;
  - re-stamp as a compare-and-set.
- **Agent wakes.** Their check becomes the parent run's read set, rechecked
  for the recipient agent.

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
- **Lock rank: step 2, beside the job.** Renewal is `FOR NO KEY UPDATE`.
  Closing, holder changes and expiry take `FOR UPDATE`, which waits out
  commits in flight.
- **Holder changes.** On a company machine, the office and screen changes of
  inventory §1.2 update the view's holder. Two of them today clear leases
  with plain UPDATEs, so they would not wait for commits holding a lock:
  `qorpera_begin_runtime_office_lifecycle` and the office-wide fences. C1b-3
  gives those paths an explicit `FOR UPDATE` on the view.
- **Authority.**
  - A run box acts as its run.
  - A computer acts in the company-wide view (paths whose covering resource
    is the root resource) and within its holder's own authority.
  - A coding session acts as agent ∩ member, with `agents/**` and `rules/**`
    read-only.
  - A test machine acts as the agent that started it.
- **Saves after a turn.** They are attributed to the view's agent and member.
  A unit that needs review waits until the agent's next turn (F3 page,
  "Programs that outlive a turn").
- **Open questions for F3:**
  - the pass format;
  - which member a coding session acts for (owner or requester; the
    who-pays work makes them the same);
  - how often views are renewed.

## Not in C1b

- Real runs on folder-v2 companies: C3 and C4.
- Effects' folder-v2 branches (sends, completion, context views, coworker
  messages) and the old writers' refusals: C1c.
- Moving job renewal to `FOR NO KEY UPDATE`. It is a branch on the company's
  core inside a runner RPC, and it only matters once folder-v2 runs exist, so
  it lands with the first real runs (C3). Until then renewal's `FOR UPDATE`
  only waits for commits, which are short.
- Cards, member answers and parked proposals: C2.
