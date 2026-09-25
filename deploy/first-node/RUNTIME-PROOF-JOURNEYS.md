# Runtime proof journeys on the Linux nodes

Started 2026-09-25 from the independent runtime review of `2a5c8f67e` (bundle
v106), "Recommended sequence" steps 4 and 5: green component checks are not
proof that the installed assembly works end to end. This file is the journey
catalogue. Results live in [RUNTIME-PROOF-RESULTS.md](RUNTIME-PROOF-RESULTS.md);
raw evidence (run ids, SQL readbacks, screenshots) lives in the operator
workspace under `outputs/runtime-proof/` and is referenced from each result row.

Contract: `QORPERA-RUNTIME-CONTRACT.md` §19 (Orders 0–10), §21 (launch
acceptance items), §24 (testing). Each journey names the Orders and launch
items it proves.

## Rules

- **One owner for live mutations.** The coordinator session (entries "Fable,
  coordinator" in the bundle registry) owns cuts, service restarts and node
  changes. A journey that stops, restarts, partitions or reconfigures anything
  runs only in a slot the coordinator agreed, and is logged in the registry.
  Journeys that only post as a test member and read back are run by the proof
  session and logged afterwards.
- **Test company first.** Journeys run in the acceptance company A1
  (`b116763d-de5c-4c73-a253-deeef5243730`: owner fixture, contributor fixture,
  Jonas as admin; Co-Founder `5e729fd9`, Research Analyst `3fab4465`, Ledger
  `be8fb5d0`). Company Qorpera (`4168e335-3ac0-4354-99f0-5dfc33428209`) is used
  only for deployed acceptance through the web app, with Jonas's OK.
- **Shared production nodes.** Node 1 runs every company's agent runs, the
  Company Computers and the secret brokers; node 2 runs member coding machines
  and the (currently idle) shared execution host (see "Where things run"). A degraded-operation scenario that can interrupt company
  Qorpera needs (1) the written plan below, (2) the coordinator's agreement on
  timing, (3) a one-line heads-up to Jonas with the time, before it starts.
- **Never touched:** the production Company Computer `aa551494` (company
  Qorpera), the contained Company41 environment, Azure.
- **Jonas's alone:** signing in, credentials, OAuth connections, creating
  accounts, payments, owner approvals, and any member action "as Jonas" in his
  browser. Journeys that need one say so under "Needs".
- **Real model accounts, purposeful runs.** Prompts are short and name the
  expected tool use; no artificial caps.
- **No Mac-SSH dependency** is built into any journey. Node reads and actions
  go through the coordinator's existing root-helper lanes.

## Tiers and verdicts

| Tier | Meaning | Status-matrix column |
| --- | --- | --- |
| **node** | Real Linux nodes, live runtime and backend, test company A1, driven by an operator through the RPCs the web app calls, executed as the fixture member | actual-node proof |
| **deployed** | Installed public interfaces end to end: the web app at `app.qorpera.com` (or the test origin) with a real member, on a real company | deployed acceptance |

Verdicts: **PASS**, **FAIL** (defect found; linked), **BASELINE-FAIL** (known
defect shown live before its fix is cut; expected), **BLOCKED** (named
dependency), **NOT RUN**.

## Evidence kept for every run

One JSON file `outputs/runtime-proof/<journey>-<yyyymmddThhmmZ>.json`:

- `journey`, `tier`, `startedAt`, `finishedAt` (UTC).
- `liveIdentity`: active bundle version and sha256
  (`qorpera_active_runtime_bundle`), migration count and last migration, runner
  image fingerprint, node release per node, exec host image, coding image and
  executor program (coding journeys), broker build (secret journeys), web build
  (deployed journeys), office image/activation (computer journeys). Taken from
  the deployment manifest once it exists; until then from the registry's
  v104–v106 cut entry (2026-09-24 21:01Z).
- `ids`: session, wake occurrences, runner jobs (`client_job_id` = run id),
  turn requests, routines + versions, todos, workers, coding sessions,
  interactions, proposals, notifications.
- `readbacks`: the exact SQL used and its rows (read-only queries through the
  Management API helper).
- `criteria`: each pass criterion with observed value and pass/fail.
- `memberView`: what the member saw or was told (message text, card, failed-run
  line, notification), with screenshot paths for deployed journeys.
- `notes`: simulated or untested boundaries, anything that differs from the
  intended deployment.

## Journey index

| Id | Journey | Orders | Launch items | Tier | State on v106 |
| --- | --- | --- | --- | --- | --- |
| J01 | One-time routine runs its only occurrence | 8, 3 | 9, 12 | node | BLOCKED on v107; baseline now |
| J02 | Finite routine runs its last occurrence (incl. quiet-hour deferral) | 8, 3 | 9, 12 | node | BLOCKED on v107 |
| J03 | Dynamic routine: agent sets its next run or concludes | 8 | 11 | node | BLOCKED on v114 (not built) |
| J04 | Concurrent todo updates keep the Company File at the newest revision | 5, 0 | 6 | node | BLOCKED on v111; read-only audit now |
| J05 | An agent can page through more than 32 todos and 16 workers | 5 | 14 | node | BLOCKED on v112; baseline now |
| J06 | Sponsor revocation fences queued and future work | 0, 2, 3, 8 | 2, 6, 17, 29 | node | ready |
| J07 | Member removal fences that member's queued work | 0 | 2, 6 | node | ready (needs re-invite path) |
| J08 | Lost response: a retried member post lands once | 1, 0 | 8, 18 | node | ready |
| J09 | Lost response inside tools: hiring, memory conflict, long card keys | 6, 8, 1 | 11, 15, 16 | node | BLOCKED on v108, v110 |
| J10 | Worker continuation: parent stays responsive, revives once | 5 | 12, 14 | node | ready |
| J11 | Coding follow-up keeps the question and answer | 9 | 14 | deployed | BLOCKED on v113; baseline with Jonas's OK |
| J12 | Coding retry after executor loss starts clean | 9 | 14 | node | BLOCKED on v113 |
| J13 | Fresh company formation | 0, 10 | 3, 20, 21 | node | ready |
| J14 | Connector disconnect fences the next run | 7, 2 | 16, 17 | deployed | NEEDS Jonas (test connection) |
| J15 | Clients-closed continuation across wake kinds | 3, 5, 8 | 1, 9, 12 | node | ready |
| J16 | Hiring: new coworker exists once and runs its first run | 8, 10 | 4, 11 | node | ready (happy path) |
| J17 | Memory write, recall, forget | 6 | 15 | node | BLOCKED on v108 |
| J18 | Company Computer: open, shell, browser, release | 4 | 11, 13, 27 | node | BLOCKED on test office wake |
| J19 | Cards: ask_member in thread and plain conversation | 1, 7 | 16 | deployed | accepted v102/v105; regression only |
| R01–R05 | Regressions from the 23 September stress test | various | various | deployed | see section |
| D01 | Orchestrator stop/restart mid-run | 3, 5 | 12, 26 | node | plan; needs window |
| D02 | Provider restart mid-run | 3 | 12, 26 | node | plan; needs window |
| D03 | One run machine loses its network | 1, 3 | 26 | node | plan; isolated |
| D04 | A node loses the backend (partition) | 3 | 12, 26 | node | plan; needs window + heads-up |
| D05 | Exhausted screen capacity | 4 | 27, 28 | node | BLOCKED on test office wake |
| D06 | NAS unavailable | 4, 9 | 13 | node | plan; needs window + heads-up |
| D07 | Secret broker unavailable | 2, 7 | 17 | node | plan; A1 broker only |
| D08 | Model provider unavailable or at its usage limit | 1 | 29 | node | D08a ready (limited account); D08b observe |
| D09 | Backend (database) outage and recovery | 0, 3, 5 | 1, 12, 26 | node | observed 2026-09-25 01:20Z; recorded |
| D10 | Node reboot | 3, 4, 9 | 13, 19 | node | plan; needs exclusive host |

"Ready" journeys run now against v106. "BLOCKED on vNNN" journeys are
prepared here and re-run when that bundle is cut live; the fix session and the
coordinator are told the journey is ready for them.

## Tooling (operator)

- **Read-only database access:** `database_check.py`
  (`~/Documents/Codex/2026-09-19/fi/work/`, Management API, `read_only: true`).
  All readbacks in this file use it. Never used for writes.
- **Posting as a test member:** see "Operator tooling" at the end of this
  file (fixture sessions for the A1 owner and contributor; no password sign-in
  by the operator).
- **Node actions:** the coordinator's root-helper lanes only.

## Functional journeys

### J01 One-time routine runs its only occurrence

- **Proves:** Order 8 (finite watch, expiry) and Order 3 (routine wake).
  Review finding #1 (High).
- **Blocked by:** v107 (finite routine last run, session "Fix one-time
  routines and build dynamic routines").
- **Setup:** A1, Research Analyst `3fab4465`, sponsor = the owner fixture's
  autonomous connection. Silent routine so no member-visible message is needed.
- **Steps:**
  1. As the owner fixture, ask the Research Analyst in its thread: "Set up a
     one-time check at <now + 5 min UTC>: list the company root once and
     finish without sending anything." (agent-set routine with
     `maxOccurrences = 1`). Alternatively create the routine through the
     member routine RPC if the agent declines.
  2. Read back the routine (`qorpera_cloud_routines`, `_versions`) and its
     occurrence (`qorpera_wake_occurrences where routine_id = …`).
  3. Wait until `scheduled_for + 3 min`.
- **Pass:** the occurrence reaches a run (`run_id` not null), the runner job
  completes, the run has zero public sends (silent), the routine ends
  `expired` after the run, and no second occurrence exists.
- **Baseline on v106 (expected BASELINE-FAIL):** routine `expired` right after
  the occurrence is inserted; the occurrence ends `cancelled` with "Wake
  recipient or source authority is unavailable" and `run_id` NULL.
- **Member told:** nothing (silent routine). On FAIL, record whether any
  notice or failed line appears for the member (today: none expected).
- **Evidence:** routine id + versions, occurrence id, run id, job status,
  observation counts for `send_message`.

### J02 Finite routine runs its last occurrence

- **Proves:** Order 8, Order 3. Review finding #1.
- **Blocked by:** v107.
- **Steps:** like J01 with three occurrences at the smallest interval the
  scheduler allows, plus a variant whose last occurrence falls inside a quiet
  window (deferred, then run after the window).
- **Pass:** three runs, all completed; the deferred one runs once after the
  quiet window; the routine expires only after the third run; no fourth.
- **Evidence:** as J01, plus `not_before` of the deferred occurrence.

### J03 Dynamic routine

- **Proves:** Order 8 (agent-managed routines), Jonas's definition of
  2026-09-25: one scheduled run at a time; after each run the agent schedules
  the next run (own timing, possibly changed task) or concludes.
- **Blocked by:** v114 (design goes to Jonas first; not built).
- **Steps:** ask the Research Analyst to "check the company root every so
  often, deciding yourself when to look next; stop after you have looked three
  times".
- **Pass:** at every moment at most one scheduled occurrence exists; each run
  either sets exactly one next occurrence or concludes; the third run
  concludes; every run completes; no occurrence is cancelled for authority.
- **Evidence:** the occurrence chain (ids, `scheduled_for`, which run set it),
  routine versions.

### J04 Concurrent todo updates

- **Proves:** Order 5 (todos are Company File state), Order 0 (versioned
  path state). Review finding #2 (High).
- **Blocked by:** v111 (todo publication race).
- **Read-only audit now (not a verdict on the race):** for every live todo,
  compare the kernel row (`qorpera_runtime_agent_todos`: revision,
  published_revision, title/state) with the Company File document at its path.
  Any todo whose file content is older than the kernel's published revision is
  a live divergence. Result: count of todos checked, count diverged.
- **Steps after v111:** in A1, one parent with two workers that both update
  the same todo within the same second (the parent dispatches both with
  instructions to set the todo state as their first action), repeated 5 times.
- **Pass:** after each round the Company File document equals the kernel's
  newest revision (title/state/revision), `published_revision = revision`, and
  no publication of an older revision was confirmed.
- **Evidence:** todo key, each revision's writer run, file object version
  before/after, confirmation rows.

### J05 Paging through todos and workers

- **Proves:** Order 5 (open work discoverable), review "workers/todos in
  context".
- **Blocked by:** v112 (todo/worker listing pages).
- **Baseline now (expected BASELINE-FAIL, one model run):** in A1 the Research
  Analyst creates 40 small todos ("proof-todo-01" … "proof-todo-40") and then
  lists them. Today the list returns 32 items plus a remainder count and no way
  to reach items 33–40.
- **Pass after v112:** the agent enumerates all 40 through `nextCursor`, and a
  state filter returns only the matching ones; same for 20 workers (worker
  part optional: 20 workers cost 20 runs).
- **Cleanup:** the agent closes the 40 todos.
- **Evidence:** tool observations for `manage_todo list` (item counts per
  page), todo rows.

### J06 Sponsor revocation fences queued and future work

- **Proves:** Order 0 (revocation fences queued work), Order 2 (effect-time
  authority), Order 3 (routine authorization), Order 8 (auth suspension with
  one notice).
- **Ready on v106.**
- **Setup:** a test-owned sponsor binding for the A1 owner fixture on its
  autonomous connection (`qorpera_create_execution_sponsor_binding`), so no
  sponsor another test or member relies on is touched; a silent routine of the
  Research Analyst on that binding, every 10 minutes (the smallest
  non-looping interval the scheduler accepts).
- **Steps:**
  1. Confirm one occurrence runs on the test binding.
  2. As the owner, set the binding `disabled`
     (`qorpera_set_execution_sponsor_status`; queued and leased jobs on it are
     terminalized by the same call).
  3. Wait for the next due occurrence (and post one thread message that would
     use the binding).
  4. Set it `active` again; confirm the next occurrence runs.
  5. Finally set it `revoked` (terminal; test-owned) and confirm one more
     due occurrence is refused, then remove the routine.
- **Pass:** while disabled/revoked no run is admitted on the binding; the
  routine is suspended (not failing every tick) and at most one notice reaches
  the member; no other member's or binding's connection is used; after
  re-enable it resumes; revoked stays closed.
- **Member told:** the suspension notice text (record it).
- **Evidence:** binding status history, occurrences with `blocked_reason`,
  notification rows, jobs.
- **Not covered here:** a second member's own connection being revoked (the
  contributor has none; adding one needs Jonas's device-code login).

### J07 Member removal fences that member's queued work

- **Proves:** Order 0 (membership revocation fences effects), launch item 2.
- **Ready on v106** (the contributor fixture is re-invited by the owner and
  accepts as itself through the same RPCs, no password sign-in).
- **Steps:**
  1. As the contributor: read a Co-Founder thread's events and read a Company
     File path it may read (baseline: allowed).
  2. As the owner: remove the contributor (`qorpera_remove_profile_member`).
  3. As the contributor: repeat the reads, try to post in the thread, try to
     accept an old card. All must be refused.
  4. As the owner: ask the Co-Founder "who are the members of this company?";
     the answer must not list the contributor.
  5. Re-invite and accept; reads work again; no work queued before removal
     runs afterwards.
- **Pass:** every call after removal refused with a permission error; the
  agent's audience no longer includes the contributor; restoring membership
  restores access for new work only.
- **Evidence:** membership rows, RPC error codes, the agent's reply.
- **Not covered:** a queued turn owned by the removed member (the contributor
  has no model connection, so it cannot own a turn).

### J08 A retried member post lands once

- **Proves:** Order 1 (idempotent sends), Order 0 (receipts). Lost-response
  recovery at the client boundary.
- **Ready on v106.**
- **Steps:** as the owner fixture, append one input to the Co-Founder thread
  with a fixed client idempotency key; repeat the exact same call twice (as a
  client would after losing the first response); then repeat once with the same
  key and different text.
- **Pass:** one input row, one turn request, one wake, one run, one reply; the
  changed-text replay is refused (not stored as a second message).
- **Evidence:** input ids, turn requests, runs.

### J09 Lost responses inside tools

- **Proves:** Order 8 (hiring), Order 6 (memory), Order 1 (cards).
  Review findings #3, #6, #7.
- **Blocked by:** v108 (memory PT412 retry), v110 (hiring outcomes, card keys).
- **Live form:** the defects need injected response loss or exact races; the
  fix sessions own the component proofs. The live journey after the cut is:
  (a) hire with a reused key and changed name → refused, not a mismatched
  receipt; (b) two runs of the same agent update the same memory fact at once
  → both confirmed, no `TOOL_OUTCOME_UNCONFIRMED`; (c) an `ask_member` whose
  idempotency key is 125 characters (operator prompt names the key) finishes
  the turn with its final message.
- **Pass:** as stated per part.

### J10 Worker continuation

- **Proves:** Order 5 (parent interruptible, complete dispatch, durable
  completion, revival once), launch items 12 and 14.
- **Ready on v106** (Step 5 live since v65/v67; parent revival never
  accepted live).
- **Steps:**
  1. As the owner fixture, ask the Co-Founder for two independent pieces of
     background work ("list every folder under the company root and count the
     files in each; separately, read the organization folder and summarise
     each agent in one line; do both in the background and tell me when
     done").
  2. While the workers run, post "Quick question: what is 17 × 23?".
  3. Wait for the revival.
- **Pass:** two workers dispatched with complete dispatches; the quick question
  is answered while both workers still run; each worker reports once; the
  parent is revived exactly once with both results (batch) and posts one
  coherent answer; the todo document in the Company File names the accepted
  outputs; all jobs completed.
- **Evidence:** worker ids and keys, dispatch observations, revival wake
  (source `worker-completion`), todo document path + version.

### J11 Coding follow-up keeps the question and answer

- **Proves:** Order 9 (follow-up identity and continuity). Review findings
  #4, #8.
- **Blocked by:** v113 (coding turn continuity), v109 (coding diagnostics).
- **Where:** coding is only connected for company Qorpera (GitHub connection,
  repository `Qorpera/qorpera-coding-proof`). Needs Jonas's OK for each run
  (his company and account).
- **Steps:** ask the Co-Founder to start a coding session on
  qorpera-coding-proof: "add a file CHECK-J11.md; before writing it, ask me
  whether the title should be 'Alpha' or 'Beta'". Answer "Beta" on the card.
- **Pass:** the follow-up turn writes the file with title "Beta" and the
  composed context (observation/turn row) carries the question and the answer;
  same worker, machine, repository and branch; draft PR opened.
- **Baseline on v106 (with Jonas's OK):** record whether the follow-up had the
  question in context (expected: answer only).

### J12 Coding retry after executor loss

- **Proves:** Order 9. Review finding #8.
- **Blocked by:** v113. Needs the coordinator (stop the executor at the right
  moment). Planned together with D01.
- **Pass:** a member retry after the executor died just after `coding_finish`
  starts a new turn that is not refused for an existing submission.

### J13 Fresh company formation

- **Proves:** Order 0 (schema seed), Order 10 (Co-Founder identity, first-run
  workflow), launch items 3, 20, 21.
- **Ready on v106** if a fixture member can create a company through the same
  RPC the web app uses (`qorpera_create_cloud_company`); otherwise needs Jonas
  to create it in the web app.
- **Steps:** as the owner fixture, create company "Proof Formation <date>";
  add the contributor fixture; observe the Co-Founder first run; answer its
  first question if it asks one.
- **Pass:** exactly one Co-Founder, the Company File schema seeded, one silent
  first-run wake that completes, the formation project/record exists, both
  members see the same Co-Founder, no template artifacts, and a protected
  direction proposal (or an explicit question) reaches the founder.
- **Cleanup:** delete the test company through the owner delete path after the
  evidence is kept.

### J14 Connector disconnect

- **Proves:** Order 7 (connector lifecycle), Order 2 (revocation fences
  queued and future use).
- **Needs Jonas:** only company Qorpera has a connection (GitHub, Jonas's
  account, used by coding). Disconnecting it would stop coding for the company.
  Options: (a) Jonas connects a throwaway Google or GitHub account in A1 from
  the web app, or (b) run on company Qorpera in an agreed window and reconnect
  afterwards (Jonas signs in again).
- **Pass:** after Disconnect, the next agent run that tries the connector gets
  a clear refusal (no token use, no stale grant), the member sees the
  connection gone, and nothing of the token appears in the thread, logs or
  receipts.

### J15 Clients-closed continuation across wake kinds

- **Proves:** Order 3 (five wake kinds on v106, silence rules), Orders 5 and 8
  (worker completion and schedules continue offline), launch items 1, 9, 12.
- **Ready on v106.** No web client open for A1 during the window (Jonas is
  asked not to open A1; the operator posts only through the API).
- **Steps (one chain, A1):**
  1. Human wake: owner fixture asks the Co-Founder to "message the Research
     Analyst asking it to write `proof/j15/<utc>.md` with one line, and create
     a routine for Ledger to list `proof/j15/` in 5 minutes, silently".
  2. Coworker wake: Research Analyst wakes from the message and writes the
     file.
  3. File-event wake: a listener on `proof/j15/` (created by the Co-Founder or
     pre-created) wakes Ledger once; Ledger's own write never wakes Ledger.
  4. Routine wake: Ledger's routine fires silently.
  5. Room wake: a room message to a room with two agents.
- **Pass:** each wake kind admitted and completed on v106 with the right
  silence rule (routine and file event silent unless asked), exactly one file
  event wake, no self-wake; all while no member client made a request (only the
  operator's first post).
- **Evidence:** the chain of wake occurrences (`wake_kind`, `source_kind`,
  `causal_root_id`, `causal_hop_count`), runs and sends.

### J16 Hiring and first run

- **Proves:** Order 8 (agents hire without member ceremony), Order 10 (hire
  overlay), launch items 4 and 11.
- **Ready on v106** (happy path; the lost-response path is J09).
- **Steps:** owner fixture asks the Co-Founder to hire "Proof Clerk <utc>" with
  one-line startup instructions.
- **Pass:** exactly one staff row, exactly one first-run wake that completes,
  only the default read grant, agent visible in the organization projection
  and the web rail.
- **Cleanup:** archive the clerk.

### J17 Memory write, recall, forget

- **Proves:** Order 6. Review findings #3, #5.
- **Blocked by:** v108.
- **Steps after v108:** tell an agent a fact twice in two runs; ask it to
  recall; ask it to forget; next run recall.
- **Pass:** one copy stored; recall finds it; forget reports how many copies
  it removed; the next composed run no longer carries the fact; the profile
  composes whole.

### J18 Company Computer

- **Proves:** Order 4, launch items 11, 13, 27.
- **Blocked by:** the test office `bb8045c8` is powered off in maintenance and
  wakes with an unmasked guest image (self-update on wake). The office
  self-update lane (`work/office-self-update-a1`) must run first; it waits on
  Jonas's owner sign-in and the coordinator's wake OK.
- **Pass:** an agent opens a screen, runs a shell command and opens a page in
  the browser, the member views it, the screen is released and the computer
  idles off with its resources confirmed free.

### J19 Cards

- Accepted live: v102 cards in the agent's own thread (2026-09-24 20:44Z),
  v105 cards in a plain conversation (2026-09-25 01:04Z). Kept as a regression
  journey for each later cut that touches `ask_member` (v110).

## Regression journeys from the 23 September stress test

Source: `~/Documents/Codex/2026-09-23/i/outputs/qorpera-overnight-stress-report.md`
(03:43–09:00 CEST, production web app 0.83.0, 12 findings). The report did
not isolate every cause and many changes landed since; each journey below
repeats the user action on the current build and records whether it still
happens. Findings 1, 9 and 10 (offline sign-in clears input, dark-mode card
contrast, whitespace company name) are web-form defects outside this runtime
catalogue; finding 2 (ten-tab navigation burst) is a load test left out on
purpose (it coincided with a backend stall and would risk real users).

| Id | Stress finding | Journey on the current build | Tier | Needs |
| --- | --- | --- | --- | --- |
| R01 | 4. Subscription sign-in HTTP 503 from the node 2 login gateway | Start "Add account → ChatGPT / Codex" and stop at the provider page (no credentials entered). Pass: the provider sign-in page opens; no 503. | deployed | Jonas (his browser, his account) |
| R02 | 6. Company File content read blocked in Claude's in-app browser (local-network access check) | Open `organization/formation.json` in the web app in the built-in browser and in Chrome. Pass: content shows in both, or the in-app failure is documented as a browser policy with a member-facing message. | deployed | Jonas signed in |
| R03 | 5, 7, 8. Appearance save, agent creation and a small file save time out / end unconfirmed in a new company | In a new company (J13), save an appearance, create one agent, save a 66-byte note. Pass: each confirms within 10 s. | deployed | Jonas signed in (or J13 as the owner fixture for the runtime part) |
| R04 | 11. One of two parallel prompts never answered | Three prompts to three A1 agents within 1 s, repeated 3 times. Pass: nine exact replies, one run per prompt, no stuck turn. | node | — |
| R05 | 11, 12. Stale failure banners after later successful turns; duplicate "Queued" bubble | After R04 in the web app: pass when no historic failure or rate-limit notice stays under a newer successful reply, and no prompt shows twice. | deployed | Jonas signed in |
| R06 | 3. A transient fetch failure shown as "company not available" / "No agents yet" | Covered by D04/D09 member view: during a backend outage the web app shows a retryable connection message, not lost access. | deployed | window (D04) |

## Degraded operation

Each scenario lists: owner, isolation, steps, rollback, what is measured, and
what the member should be told. "Owner" acts on the live system; the proof
session writes the plan, drives the test-company side, observes and records.

**Where things run (read from allocations, 2026-09-25 03:30Z):** agent runs
of both companies are placed on node 1 (`native25-phql-a1`: 577 company
Qorpera and 26 A1 allocations in 3 days, last A1 run 2026-09-24 21:01Z); node
2's shared execution host (`native26-phql-b1`) has had no allocation since
2026-09-24 03:40Z. Member coding machines are on node 2 (`coding-node-02`,
company Qorpera only). Company Computers and both secret brokers are on node 1.
So a service restart on node 1 touches company Qorpera's agent runs, and one
on node 2 touches its coding sessions. Only a single run machine or a single
broker is isolated.

Common rules for D01–D10:

- A **pre-check** read-only query right before the start: no active company
  Qorpera job or coding session in the last 10 minutes (else wait), no cut in
  progress (registry), node grants valid.
- A **stop condition** written in the plan: the moment an unrelated job fails
  or a company Qorpera member posts, the coordinator rolls back at once.
- Every action goes through the coordinator's root-helper lanes with intent and
  result receipts; nothing replays automatically.
- **Evidence:** the time of each action, the job/wake/allocation rows before
  and after, the member-visible outcome (thread events, failed-run line,
  notifications), and the time to recovery.

### D01 Orchestrator stop/restart mid-run

- **Owner:** coordinator. **Where:** the node 1 host orchestrator
  (`native25-phql-a1`). **Isolation:** none; window + heads-up.
- **Steps:** (1) pre-check; (2) the proof session posts the 150-call prompt
  (v104 acceptance text) to the A1 Co-Founder; (3) at about call 50 the
  coordinator stops the orchestrator for 60 s, then starts it; (4) observe
  until the run is terminal.
- **Rollback:** start the orchestrator (the unit has `Restart=always`; the
  lane also starts it explicitly). If the A1 run is stuck leased after the
  lease deadline, the coordinator releases it by the documented lease expiry,
  never by editing rows.
- **Measure:** lease behaviour, whether the run is resumed, retried as a new
  attempt or failed; duplicate public sends or writes; seconds to terminal.
- **Pass:** no duplicate send; a terminal outcome within the lease window; the
  member sees either the reply or a failed-run line with Try again, and Try
  again completes.

### D02 Provider restart mid-run

- **Owner:** coordinator. **Where:** node 1 LXD provider. **Isolation:**
  none; window + heads-up. Same shape as D01.
- **Measure/pass:** the run VM is released or adopted, never leaked; the
  allocation is released only after confirmed deletion; the member outcome as
  in D01.

### D03 One run machine loses its network

- **Owner:** coordinator (LXD action through the root helper). **Isolation:**
  one A1 run VM only; safe during the day.
- **Steps:** post the 150-call prompt; once its run VM exists, detach that VM's
  NIC (`lxc config device …` on that instance only) for 120 s, then reattach.
- **Rollback:** reattach the NIC; if the VM does not recover, let the provider
  retire it through its normal failure path.
- **Pass:** the run fails cleanly or resumes; the allocation is released;
  the member sees a failed-run line with Try again, and Try again completes.

### D04 A node loses the backend (partition)

- **Owner:** coordinator. **Isolation:** none. Needs window + heads-up.
- **Steps:** block the node's egress to the backend for 3 minutes with a host
  firewall rule whose removal is armed first (a `systemd-run --on-active=180`
  timer that deletes the rule), during an A1 run.
- **Rollback:** the armed timer removes the rule; the manual removal command is
  written in the lane before the rule is added.
- **Measure:** what fails, what retries, stuck leases, duplicated work, and the
  time to full recovery after the rule is removed. Compare with D09 (the
  natural backend outage lost one revival for good).

### D05 Exhausted screen capacity

- **Owner:** proof session (agent/member actions). **Blocked by:** J18 (test
  office wake).
- **Steps:** six A1 agents each hold a screen (office max 6); a seventh asks
  for one; release one; the seventh retries.
- **Pass:** the seventh gets a capacity refusal the agent reports plainly; after
  a release it succeeds; screen and computer-hour records stay single.

### D06 NAS unavailable

- **Owner:** coordinator. **Isolation:** the NAS serves both nodes and every
  company (Company Computer workbenches, coding workspaces, recovery volumes).
  Needs window + heads-up; prefer a test-only variant (block NFS only for the
  test office's workbench mount if the mount layout allows it; decide after
  J18).
- **Rollback:** remove the block (armed timer as in D04).
- **Measure:** writes refused rather than lost; what the agent and member see;
  recovery after return.

### D07 Secret broker unavailable

- **Owner:** coordinator. **Isolation:** stop only the acceptance broker
  (`qorpera-phql-broker`, port 18448, A1). Before the start the coordinator
  confirms no other company's captures, operations or repository credentials
  route to it (the node 1 map routes company Qorpera to `qorpera-prod-broker`
  18547; requests with no company argument go to 18448).
- **Steps:** stop the broker; an A1 agent tries an operation that needs a
  captured secret (the Step 2 canary secret); start the broker; retry.
- **Rollback:** start the unit.
- **Pass:** a clear, non-secret refusal; nothing leaks; the retry works after
  the restart.

### D08 Model provider unavailable or at its usage limit

- **D08a (ready):** the A1 owner's connection `cb29f1d4` (sponsor `13f2e314`)
  is at 100 % of its weekly window until 2026-09-26 14:11Z. One post on that
  sponsor. Pass (launch item 29): the member is notified and the run continues
  on the next eligible connection of the same member through a recorded
  sponsor handoff; no other member's credential is used.
  `qorpera_execution_sponsor_handoffs` has never held a row on this backend.
- **D08b (natural):** provider 5xx/outage events are recorded when they
  happen; pass = no sponsor handoff on a transient outage.

### D09 Backend (database) outage and recovery

- **Observed:** 2026-09-25 ~01:20:30–01:30:04Z (Supabase outage, not caused
  by our load; registry 01:10–01:50Z entry). Recorded from the database after
  the fact; see the results file (finding P-D09-1).

### D10 Node reboot

- **Owner:** coordinator. **Isolation:** exclusive host (§24.3). A node 2
  reboot interrupts company Qorpera's coding machines; a node 1 reboot
  interrupts every agent run and both Company Computers. Boot-return was proven
  on 2026-09-16/17; this re-proves it on v106. Needs window + heads-up, and the
  boot-bound root helper must be re-bound by Jonas afterwards.

## Operator tooling

Drivers live in the operator workspace `work/runtime-proof-a1/`
(`~/Documents/Codex/2026-09-13/take-over-the-qorpera-runtime-work/`).

- **`proof.py`**: `liveid` (bundle, migrations, nodes) and `sql "<select>"`;
  `save()` writes the evidence JSON. Read-only (Management API,
  `read_only: true`).
- **Posting as a test member (node tier):** the RPC the web app calls
  (`qorpera_post_company_room_message`, `qorpera_upsert_cloud_routine`, …),
  executed in one transaction as the fixture member (`set local role
  authenticated` + that member's JWT claims), the pattern the coordinator used
  for the v104 150-call acceptance (`work/thread-model-routeB-a1/w.py`). No
  password sign-in: the older lanes that mint an owner session with the
  fixture's password (`native26-owner-auth-b*/prepare.py`,
  `file-transfer-a1/agent.py`) are Jonas's step and are not used here. This
  path exercises the RPC and every check inside it, not PostgREST/GoTrue;
  the deployed tier covers those.
- **A1 threads (room, session):** Co-Founder `b064d903…`/`af84752c…`,
  Research Analyst `7f2123ac…`/`3f518dd8…`, Ledger `1e083afb…`/`e069294a…`.
  Owner fixture `f29d8f64-fd2d-4254-9c8c-2c260000c1fb`, sponsors `82ccd029…`
  v1 and `1a7aa9d2…` v1 (autonomous, the third OpenAI account). The
  contributor fixture has no model connection (a new one needs a device-code
  login by Jonas).
- **Observe queries:** `work/native26-wake-c1/observe.sql` (routine → wake →
  run → sends), `work/cut-v106-a1/acceptance/watch.py` (job + observation
  counts + coding sessions).
- **Node actions:** only through the coordinator's root-helper lanes (SSH
  from the operator Mac to `qorpera-task-admin-*`; grants to 2026-09-26 00:01Z,
  boot-bound). Nothing in this catalogue adds a new dependency on that path;
  the degraded scenarios are run by the coordinator with its existing lanes.
- **No `timeout` binary on the operator Mac**: wrap waits in Python, not
  `timeout`.
