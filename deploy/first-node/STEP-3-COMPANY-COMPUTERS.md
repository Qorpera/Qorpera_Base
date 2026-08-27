# Step 3: Company Computers

**Status:** ratified design direction, 2026-08-25 (founder decision after the
Grok bot-computer comparison). This document is the authoritative goal for
what Company Computers look like. Step 3 implementation planning starts from
here; deviations need an explicit founder decision recorded in this file.

Step 3 fills the slots Step 2 deliberately deferred: the persistent
interactive desktop presented as a Company Computer, browser/GUI computer
use, GPU allocation, and multi-node placement. It must extend the Step 2
contracts — logical computers, compute identities, provider adapters,
capabilities, checkpoints, runners — not replace them
(see [STEP-2-ARCHITECTURE.md](STEP-2-ARCHITECTURE.md)).

## The shape in one paragraph

One persistent virtual machine per company environment — the Company
Computer — whose working storage is the company's existing NAS `live` tree
rather than a local disk. That tree is the Company File: it also sits beside
browser profiles, hidden desktop state, installed tooling, and work in
progress. Every staff agent of the company works on the same live tree and
sees changes immediately; each gets its own screen as a parallel work
surface. The cloud remains coordination authority for identities, leases,
screens, and outward effects, but ordinary file durability does not require
a publication pass. Occasional NAS snapshots provide rollback. Ephemeral
execution lanes from Step 2 continue alongside for explicit immutable
publication/review operations and work that needs hard isolation.

## Principles

1. **Tenancy is the company, not the user account.** The sharing unit is a
   company environment. This is the direct rejection of the Grok model,
   which shares one computer across all bots of a *user account* and thereby
   makes the account the trust domain. The existing `logical_computer_id`
   slot in the work and turn contracts is the binding point: a Company
   Computer is a logical computer, and a turn targeted at it runs there
   instead of an ephemeral lane.

2. **Shared visibility by default; separation is not a feature.** All staff
   agents see the same files, browser sessions, tools, and work in progress.
   One agent continues another's work. Per-staff OS separation walls are
   explicitly rejected as a default: the separation between what agents see
   is a forced attribute and a silent downside, not safety. The Company
   Computer is one trust domain per company environment, and we state that
   honestly. Work that genuinely needs stronger separation runs in an
   ephemeral lane — the answer to "I need real isolation" is the lane
   contract that already exists, never a partitioned Company Computer.

3. **Storage is carried by the NAS, not delegated to the machine.** The
   Company Computer is near-stateless: its working world is a per-company
   dataset on the NAS, mounted into the VM. Growth is NAS pool growth —
   effectively unbounded, with nothing per-VM to resize. Recovery and
   time-travel are occasional dataset snapshots, taken outside ordinary turn
   completion. Moving a Company Computer between
   nodes is reattaching the share, which solves multi-node placement's data
   gravity before it exists. There are no per-machine storage silos of the
   kind the Grok bots delegate to each computer.

4. **The NAS `live` tree is the Company File, not a cache of it.** Desktops
   and Company Computer jobs mount the same directory and edit it in place.
   There is no standing sync agent, per-turn rematerialization, copy-out, or
   automatic publication verifier between a successful write and company
   durability. This is what makes the company a smooth, continuous
   workbench. The Step 2 content-addressed snapshot path remains available
   when an operation explicitly needs an immutable input/output, review, or
   outward-effect receipt; it is not the normal filesystem path.

5. **Coordination authority stays cloud; bytes and screens live on company
   iron.** The control plane (turns, leases, fencing, identities, screens,
   explicit outward-effect receipts) remains the hosted service and is the
   single writer for coordination state.
   The NAS and the nodes carry working bytes, execution, and desktops. The
   NAS additionally serves as an object-bytes fallback when the cloud sheds
   (the object loader's `nas` primary mode already exists for this).

6. **Credentials are the one thing never parked on the shared machine.**
   Files, sessions, and profiles are shared; provider subscriptions are not
   — not as a separation feature, but because the sponsor-binding model is
   structurally per-identity: a member's personal Codex or Claude
   subscription is theirs, revocable, concurrency-bounded, and terms-bound.
   Sealed identity capsules keep delivering credentials per staff session,
   exactly as in Step 2, and leave no residue on the dataset. This is the
   lesson from Grok's own warning — "do not place a credential on it if
   another Bot should not use it" — designed out instead of documented
   around. Browser-session sharing with a signed-in human account is an
   explicit per-profile grant by the member, not an ambient default.

7. **Screens are parallel work surfaces, not boundaries.** Each staff agent
   attaches to its own screen (desktop session) on the shared machine;
   several agents work in parallel; one computer-use task occupies one
   screen at a time. This mirrors the Grok concurrency shape, which is
   good UX, while the trust story above stays ours.

8. **No local-GPU assumption.** The first node's GPU has been removed.
   GPU-needing work is a placement concern for the multi-node story, not a
   property of the Company Computer.

## What Step 2 already provides for this

- `logical_computer_id` in the work spec and turn request contracts
  (currently always null) — the targeting slot for Company Computers.
- Compute identities, sponsor bindings, sealed credential capsules, and the
  login-VM/identity-volume machinery — per-staff credential delivery.
- Content-addressed company snapshots, signed-URL object transport, and the
  closure verifier — retained for explicit immutable/review/outward-effect
  paths, not ordinary live Company Computer writes.
- The provider contract and image provenance cycle — a Company Computer
  image is built, signed, and activated exactly like a runner image.
- The proposal/review machinery — concurrent captures from a shared working
  copy become proposals at publication time rather than corruption.

## Step 3 adds

- A persistent VM class per company environment behind `logical_computer_id`,
  with lifecycle (create, snapshot, migrate, recover) driven from the
  control plane.
- The NAS dataset layout and mount contract (`live`, browser profiles, and
  hidden machine state), plus occasional NAS rollback snapshots. There is no
  publication-head sync agent.
- Screen attach/detach: per-staff desktop sessions, the shell UX for
  watching and driving them, and the one-task-per-screen scheduling rule.
- Placement and multi-node: which node hosts which Company Computer, GPU
  scheduling, and migration by share reattachment.

## Ratified decisions

- **2026-08-27 (founder): the existing NAS `company41/live` tree is the
  Company File, with no ordinary publication pass.** Company Computer jobs
  and desktops edit it directly. Successful ordinary turns do not capture,
  upload, verify, or advance a second head. Rollback uses occasional NAS
  snapshots; Step 2 immutable snapshot/publication machinery is reserved for
  explicit operations that require it and for hard-isolation lanes.

- **2026-08-26 (founder): screens follow the Grok bot-computer model —
  shared computer, individual screen per staff agent.** Transport is
  per-screen TigerVNC/XFCE desktops with noVNC-style embedding over the
  existing capability-gated paths (never public); the audit trail is
  transcript events plus periodic content-addressed keyframes, not
  continuous video. Details and rejected alternatives:
  [STEP-3-SCREENS-DECISION.md](STEP-3-SCREENS-DECISION.md).

- **2026-08-25 (founder): members share one computer, and the computer is
  the interface into the entire company.** Different members' staff agents
  all work on the same Company Computer; member-connection sponsorship
  (personal Codex/Claude subscriptions) must therefore be able to drive
  work on company-owned compute identities. This requires deliberately
  extending Step 2's two enforcement points — the turn RPC's
  capsule-ownership rule (capsule matched to the sponsoring member's
  identity rather than the computer's pinned identity) and
  `validateCloudRunnerWork`'s ownership/sponsor check — sequenced strictly
  after Step 2 acceptance closes. The payment structure for shared-computer
  work is explicitly not yet decided and must not be baked into these
  contracts prematurely.

## Open questions (decide during Step 3 planning, not silently)

- ~~Screen transport and audit recording~~ — decided 2026-08-26, see
  "Ratified decisions" and [STEP-3-SCREENS-DECISION.md](STEP-3-SCREENS-DECISION.md).
- ~~Publication cadence from the working copy~~ — decided 2026-08-27: none
  for ordinary Company Computer work; occasional NAS snapshots are rollback
  points, not publications.
- Verified-snapshot bounds: the snapshot contract currently caps 50,000
  files / 1 TiB; the working store is unbounded, and raising the published
  bounds is a deliberate decision when a company approaches them.
- Whether the control plane remains hosted or moves to owned infrastructure
  — the availability incidents of 2026-08-25 are the motivating record; any
  move must preserve the single-writer coordination model.
