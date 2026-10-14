# Step 8: scheduler, listeners, agent-set routines and agent hiring

Date: 2026-09-19/20. Branch point: `dfdb64ce3` (master, bundle v37).
Status: source, SQL proofs and live-model behavior screens. Not deployed; no
live acceptance on the nodes yet.

## What already existed (built for Order 3)

The wake bus needed a working scheduler, so most of contract 16.3 was already
source-implemented and proven: schedule triggers (interval, weekly wall clock,
window and months) with IANA time zones and DST handling in the orchestrator's
reconciler, deterministic occurrence keys with a cursor compare-and-set,
catch-up coalescing, Company File listeners that walk the revision chain once
with a causal-loop fence, the listener-is-not-a-cron invariant, and the routine
wake policy with valid silence. See [the wake bus record](RUNTIME-STEP-3-WAKE-BUS.md).

What was missing for Order 8: an agent could not give itself a routine, nothing
expired, there was no quiet policy, nothing suspended a routine whose account
stopped working,
and routines are control-plane rows rather than Company File documents.

## Built in this change

### Agents set up their own standing work (founder decision 2026-09-19)

`manage_routine` (tool) -> `qorpera_manage_agent_routine(p_binding, p_request)`:
list, upsert, pause, resume, remove. The routine always belongs to the calling
agent; the model cannot choose another agent, a requester, a model account or a
computer. **No member approval is involved.** The operation uses the ordinary
run authority chain (locked run, path actor, read-set assertion, wake work gate,
operation receipt with exactly-once replay), and a file listener may only watch
a path the agent and its requester may read. Limits: 32 live routines per
agent, one trigger per routine, five minutes minimum interval.

The tool offers the three shapes people use (`every`, `weekly` with a Monday to
Friday default, `file_change`) and compiles them to the scheduler's closed
trigger forms; the trigger id is host-owned.

**Model account (founder decision 2026-09-20: unattended use is not a
setting).** The kernel's consent and sponsor records stay, because runs, leases
and custody bind to them, but they are granted by default. The web client
records the owner's consent and binds the consented version whenever an account
is bound. An agent's routine uses the account that already runs the agent; when
the requesting member's own account has not recorded consent yet, saving the
routine records it in that member's name and binds the account. A routine waits
(`needs_model_account`, one notice) only when the requester has no connected
account at all.

### Scheduler rules as code (contract 16.3)

| Rule | Enforcement |
| --- | --- |
| Expiry, finite watches | `expires_at`, `max_occurrences`; status `expired`. The control-plane tick sweeps expiry; the occurrence that reaches the limit expires the routine; a later slot is refused. One status stops both trigger types, because the reconciler lists active routines only and a listener cursor is active only while its routine is. Expiry closes future scheduling only (2026-09-25, `20260925107000`): an occurrence queued before a normally running routine ended still runs and completes; a routine paused (or whose agent was archived) before it ended runs nothing more (`expired_while_active`); a started run keeps its routine version while its job is live, so a routine run can save its own routine (test `371`). |
| Saves keep the position | A new routine version keeps each schedule trigger's cursor, so a save does not run the routine at once. Agent saves carried it unconditionally since `20260922151000`; v133 (#320) moves them onto the same `qorpera_routine_version_schedule_position`. Member saves carry it since migration `runtime_member_routine_cursor` (2026-09-25, test `373`), through `qorpera_routine_version_schedule_position`: the same timing (`qorpera_routine_schedule_timing`: trigger equal apart from `replyPolicy`, the order of `weekdays`/`months`, and `intervalMinutes` on a `localTime` trigger) keeps the exact position while the routine is active or its next slot is ahead, and a slot whose occurrence is still `queued` (not yet a run; refused once a newer version exists) is offered again to the new version (only slots after the last one that became a run; `qorpera_routine_occurrence_count` counts a slot once toward `max_occurrences` and in the agent view; a waiting run an edit replaces still counts); changed timing, or any save of a paused or ended routine whose next slot passed, restarts the schedule at the save (no run at once, no catch-up), at a millisecond position because the orchestrator sends the cursor back as a JavaScript `Date`, with `next_due_at` one millisecond later; a never-run cursor, a waiting kickoff or a new trigger id stays fresh and keeps its kickoff. A switch back on without a new version (an agent's resume) restarts an overdue cursor in place (trigger `qorpera_cloud_routine_resume_restarts_schedule`). `qorpera_routine_next_run_at` (v131) does not show a restart position, so the next run is blank until the scheduler raises it to the first new slot at its next poll (First slot row below). |
| Quiet hours | Per routine `quietHours {start, end, timeZone}`, including windows across midnight. An occurrence admitted inside the window keeps its identity and waits (`not_before`) for the window's end. |
| Weekday default | A wall-clock routine runs Monday to Friday unless the agent names other days. |
| Dynamic routines (2026-09-25, `20260926131000`, bundle v131) | Trigger kind `once {at, timeZone, replyPolicy}`: each version holds one next run, inserted when it is saved (`once:<version>:<n>`); the orchestrator never sees it (no schedule cursor). The run decides through `decide_routine` (`qorpera_decide_agent_routine`): `next` saves a new version with its instant and optional new intent, title, effort and reporting; `conclude` sets status `concluded` with a reason. The kernel refuses that run's final send and its completion until the routine moved on; the host shows the model the reason first. The control-plane tick (`qorpera_restore_dynamic_routine_runs` in the drain; on folder-v2 `qorpera_folder_restore_dynamic_routine_run` since C1c-3e, and legacy sweep F3b, 20260930295000, dropped the legacy tick) restores a missing run: three retries at once, then 15 min doubling to a day, never giving up by count. A new version cancels older queued runs; a conclusion cancels queued ones. Test `372`; model screens in `~/work/dynamic-routines-behavior`. |
| Authorization suspension | Three occurrences in a row cancelled because the account can no longer run unattended pause the routine (`authorization_failed`) and create one durable notification for the account owner. A materialized occurrence resets the count. |
| Agent saves (2026-09-25, migration `runtime_agent_routine_cursor`, test `374`, merged into `373` §15 on the company folder in the legacy sweep) | An agent's new version takes its cursor from `qorpera_routine_version_schedule_position`, like a member's save (row above), so both paths keep, restart or start fresh by one rule; the agent's status-only `resume` (also after the authorization suspension) is covered by `qorpera_cloud_routine_resume_restarts_schedule` from `runtime_member_routine_cursor`. For both paths, a wall-clock trigger's `startAt` at or behind the reached position is not timing (`qorpera_routine_trigger_after`); an interval trigger's `startAt` anchors its grid and stays. After a restart, "Next run" is empty until the scheduler's next poll, which raises `next_due_at` to the first slot after it (row below); the routine is then not listed until that slot. |
| First slot (2026-09-25, migration `runtime_routine_first_slot` (`20260927020000`), test `377`) | When a listed trigger has nothing due and waits for its first slot (a restart position, or a fresh cursor whose trigger names a `startAt` after the version's effective time or a window), the orchestrator raises its `next_due_at` to the slot it computed through `qorpera_advance_routine_next_due` (edge action `advance_next_due`). It compares the current version, the active status and the exact position it read (a JavaScript `Date` ISO string, as for the enqueue), only ever raises `next_due_at`, never moves `last_scheduled_for` and creates no occurrence; a read that moved answers `stale`. The routine leaves the listing until the slot, and `qorpera_routine_next_run_at` shows the slot (also for a raised fresh cursor; a restart position still shows nothing until the raise). A fresh cursor stays fresh, so it keeps its first-run rule, and one that may still owe a kickoff (no later start, no window) is never raised: the orchestrator does not ask and the call answers `stale`. An answer that needs no write (`unchanged`) comes before the company's fence. Deploy order: migration, then the `runner-orchestrator` edge function, then the orchestrator artifact (an older edge function answers the new action with 400; the orchestrator reports it, stops asking for ten minutes and then asks again, so routines stay listed as before meanwhile). |

### Agents hire coworkers and open group chats, with no member approval (founder decision 2026-09-20)

`hire_agent` writes the canonical fourteen-field agent document and
`create_group_chat` writes the canonical room document, both through the
governed path gateway. These are organization documents, and an organization
document only becomes an agent or a room in the approval lane, where the
projection runs. The lane stays and the approval is given by policy:
`qorpera_self_approve_organization_proposal(p_binding, p_proposal_id)` approves a
NEW agent or NEW room that this run proposed, in the name of the requesting
member when that member may approve, else of the company owner, and the runtime
applies it at once through the projecting entrypoint
(`qorpera_apply_company_path_approval_v3`). The projection creates the agent with
its default read grant and single first-run wake, or the room with its members.
Limits per run: three hires, five rooms. If the cloud declines, the document
stays an ordinary proposal and the agent says so.

Path authority gained one narrow rule, guarded by a migration-time assertion
that agent and room documents are still proposal-gated: any active agent holding
only the default read grant may create a new agent or room document and the
`organization`, `organization/agents` and `organization/rooms` folders; only the
company Co-Founder may propose a change to an existing agent or room, and a
member approves that. The approval lane's source-authority re-check uses the
same rule. The requesting member's own write authority still applies.

### Responsibilities are the agent's description (founder direction 2026-09-20)

The employee overlay now treats the job description as the agent's list of
responsibilities and the reference it works from: on a first run it orients
itself, reads its sources, sets up the routines that keep each responsibility
alive and says briefly what it set up; with no responsibilities written it asks
the one question that settles its role. The web client's default description is
a name-free placeholder (the old one hard-coded the agent's name and went stale
on rename, and duplicated platform behavior). A responsibility-cadence mechanism
built from responsibility objects was removed again before merge, because agents
now create their own routines. The structured responsibility objects, their
pages, escalation routing and the contract's 14.3 are unchanged here and need
their own decision.

## Proofs

Real PostgreSQL (task-local 18.6 on `company41-node-02`; CI runs the pinned
17.6 image), every migration applied, then:

- `370_runtime_agent_routines.test.sql` (deleted in the legacy sweep): acknowledgement gate, creation with
  no member step, same agent and account, exact replay, versioning, listing,
  closed request (no other agent, no sponsor, no trigger id, no one-minute
  loop), control-plane-only execution, pause/resume/remove, finite watch,
  expiry by tick, quiet-hour deferral, suspension with one notice, and the
  automatic consent and binding for an account that never recorded it.
- `375_runtime_agent_hiring.test.sql`: end to end with a read-only agent: the
  hire is approved by policy and applied; the staff row, exactly one first run
  and only the default read grant exist; the approval is recorded in the
  requesting owner's name; an existing agent document, another proposal and
  ordinary paths stay closed; a fourth hire in one run is refused; a group chat
  is created with its members.
  (Deleted in the legacy sweep, step B2: it ran on a snapshot-v1 company. On the
  company folder, a run's hire is tested in `774_folder_state_run_hire.test.sql`.)
- The other 52 SQL test files pass unchanged with these migrations. Six files
  fail identically with and without them on that host (loopback connections
  and time zone data of the task-local server); CI is authoritative.

Unit tests: 11 routine-tool, 8 hiring-tool, plus the runtime tool-list and
prompt composition tests.

Live-model screens (same runner as the Step 10 passes, synthetic effects):
a new hire told "make sure we never miss a bad week" set up its own
file-change watch with quiet reporting; "every weekday morning, only tell me if
more than 10 wait" became one business-day routine in the member's time zone;
"check again tomorrow at 09:00" became a one-occurrence watch; a one-off
question created nothing; with no unattended account the agent said so plainly.
An agent whose description listed two responsibilities in prose read its
sources, set up three routines covering both, flagged a partner already quiet
for twelve days and named its chosen times as assumptions; one with no
responsibilities written asked a single question. The Co-Founder hired an
onboarding owner with a real job description, opened a named group chat with
two coworkers and the founder, did not hire for a one-off task, and still argued
against three sales hires that conflict with direction.

## Bundle

Runtime bundle v38, `6e2eaaabd4f46cbc58e02621eab982da38247c4cd5d88d6dd43bae6ea45c12fb`
(`20260920003000_runtime_bundle_activation_v38.sql`). Guest artifact pinned from a
Linux x64 build on `company41-node-02`: `qorpera-native-provider-host.mjs`,
1,348,166 bytes, `22b2141dd5e5df0dadac761a8feabf96a106ad672a28b42e4cd03d9fb1f25193`.
Seven bundle, guest-package and SQL-harness tests passed there; SQL context
parity passed after all 285 migrations. `npm run check` passes. If master ships
another activation first, allocate the next version and regenerate; never
relabel a shipped bundle.

## 2026-09-20: responsibility pages removed, contract amended

The web client no longer has responsibility pages: the per-responsibility page
and route, the responsibility map on the Organization page, the Responsibilities
page of the agent details panel and the sponsoring-responsibility link on
project pages are gone, with their styles. The agent's description field is
labelled "Responsibilities". The Organization page shows the Co-Founder, active
and completed projects, and staff. The role overlays no longer speak of a
responsibility map, measures or a recorded threshold; an agent works from its
description and the Co-Founder reads its coworkers' descriptions to see who owns
what. This is runtime bundle v39,
`e0dbed43d0056e8fc3876ec522fe378a287761f49174f636db3195ae20901620`, guest
artifact 1,348,310 bytes,
`6c33770175080f14b218d2863d7eaa4fe9e5606ff65d9d247efcc5f66fcc9e68`, SQL context
parity after 287 migrations.

Review follow-up in the same change (`20260920005000`): a policy approval whose
apply did not finish is renewed when the same run retries, instead of being
refused as expired; asking again after it was applied is a replay. `375` now
also proves that case and a hire or room requested by a contributor, where the
approval is recorded in the company owner's name.

The contract's 2026-09-20 amendment records the model, what is withdrawn, what
still exists in the cloud (responsibility documents, projections, grants and
escalation operations, no longer surfaced), and tools as the intended
replacement for live measurement. `work/cut-bundle.sh <version> <timestamp>` in
the task folder performs a bundle cut in the required order.

## 2026-09-20: responsibility objects removed from the cloud

Migration `20260920070000_runtime_retire_responsibility_objects.sql`.

- The eight responsibility tables (objects, measures, measure sources, path
  resources, external operation grants, agent grants, escalations and their
  signals) are dropped (founder decision: no company holds responsibility data
  worth keeping). The drop is not CASCADE, so anything still depending on them
  fails the migration instead of vanishing with them.
- Dropped: `qorpera_escalate_responsibility`, the list and resolve operations
  and their helpers, the responsibility resources read helper and the bootstrap
  document minter. The three agent tools and `cloud-responsibility-tools.ts` are
  gone from the runtime.
- Live functions are edited with exact-match checks, each function in one
  step: company creation no longer mints or expects the documents or the folder
  (a genesis tree is five entries), the organization projection and its deferred
  assertion lose the kind, scoped path resources are project-only, agent grants
  ignore `grants.responsibilities`, agent deletion asks about led projects only,
  file retention no longer follows open escalations, and the Co-Founder's seeded
  description uses the new wording.
- Rewritten whole: the organization path kind, the path permission rule
  (a retired responsibility scope is owners and admins only; a project-scoped
  resource is reached by project members, and by members as owner or admin), and
  the read model patch that answers `responsibilities: []` and reports projects
  as company-scoped.
- The migration ends by failing if any public function still names a dropped
  table. That check earned
  its place: a `%rowtype` declaration of a moved table breaks a function when it
  is compiled, even in a branch that can no longer run, and it broke group chat
  creation until the branch was removed.
- Object gateway: the bootstrap provisioner builds no responsibilities folder,
  treats a claim that still carries documents as a cloud that has not migrated
  yet (retry later), and no longer supplies document text for those paths.
  Rollout order cannot block company creation: the database also accepts the
  genesis tree of a gateway that still builds the empty folder, and a new
  gateway that meets a database which still mints documents waits and retries.
- Rollout preflight template now asserts the retirement and the new agent
  operations instead of the escalation objects.

Runtime bundle v46, `0fd2489b4280943e974cd362e2ca2fe04860843e71af95ba7426f3a01a9d681f`
(migration `20260920070000`, activation `20260920071000`; the slot assigned in
the shared bundle registry), guest artifact 1,338,813 bytes,
`4c1c280ecc4faabca5f1a25869f8fd907caa91d88fe13fb2c3586aed06ac5620`, SQL context
parity after 307 migrations on master `863536b30` (v45).

Proofs: `310_company_organization_kernel.test.sql` (deleted with snapshot-v1 in the
legacy sweep, B2b) rewritten to the new model
(company born without the objects, the old document as an ordinary file that
needs no review, the projection refusing its text, the read model shape, a
retired scope closed to agents, the tables gone);
`370`, `375`, `365` and the rest of the SQL suite unchanged and passing; object
gateway 432 tests; shell tests pass except `cloud-presence.test.ts`, which is
timing dependent (two passes in three unchanged runs) and untouched here.

## Not built; Order 8 stays open

1. **Routines as Company File intent with projection consistency.** The order
   table asks for "Company File intent plus one compiled trigger". Today a
   routine is a control-plane row. Organization documents are projected only on
   the approval and member-command paths; a routine that needs no approval
   would need a projection hook in the native commit path and the object
   gateway supplying document text there. That touches the most fenced part of
   the kernel and deserves its own reviewed design.
2. **Vendor listeners** (webhook verification, channel membership, identity
   gating) depend on Order 7 connectors and secret custody for listener secrets.
3. **Listener operation filter** (create/update versus delete) is reported in
   the payload but cannot be subscribed to.
4. **Member-saved routines** do not yet expose expiry or quiet hours in the web
   client, and the web client does not show agent-made or responsibility
   routines as such.
5. **Live acceptance**: clients closed, an agent-made routine firing on the
   node, and an agent-made hire with its first run and an agent-made group chat
   appearing in the web client. Needs the migrations, bundle v38 and the runner image rolled
   out through the existing lane.
