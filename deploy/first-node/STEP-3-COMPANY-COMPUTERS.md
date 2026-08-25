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
Computer — whose working storage is a per-company NAS dataset rather than a
local disk, holding a standing working checkout of the entire Company File
plus everything the company's staff agents accumulate: browser profiles,
installed tooling, work in progress. Every staff agent of the company works
on the same shared machine and sees the same state; each gets its own screen
as a parallel work surface. Authority stays in the cloud: the control plane's
verified snapshot chain remains the only authoritative Company File, and
nothing on the Company Computer becomes company-durable without passing the
publication verifier. Ephemeral execution lanes from Step 2 continue to exist
alongside, unchanged, for verified publication turns and any work that needs
hard isolation.

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
   time-travel are dataset snapshots. Moving a Company Computer between
   nodes is reattaching the share, which solves multi-node placement's data
   gravity before it exists. There are no per-machine storage silos of the
   kind the Grok bots delegate to each computer.

4. **The Company Computer holds the entire Company File — as a working
   copy.** A standing checkout of the Company File lives on the dataset and
   syncs deltas from the verified head (the content-addressed signed-URL
   transport built in Step 2 is the sync mechanism). This removes the
   per-turn full rematerialization cost that repeatedly destabilized Step 2
   acceptance. The working copy is never the authority: publication still
   captures, uploads the delta, and passes closure verification, and the
   verified snapshot chain in the control plane remains the only
   authoritative Company File. Writing to the share is not publishing.

5. **Authority stays cloud; bytes and screens live on company iron.** The
   control plane (turns, leases, fencing, verified snapshots) remains the
   hosted cloud service and is the single writer for coordination state.
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
  closure verifier — the sync and publication mechanisms.
- The provider contract and image provenance cycle — a Company Computer
  image is built, signed, and activated exactly like a runner image.
- The proposal/review machinery — concurrent captures from a shared working
  copy become proposals at publication time rather than corruption.

## Step 3 adds

- A persistent VM class per company environment behind `logical_computer_id`,
  with lifecycle (create, snapshot, migrate, recover) driven from the
  control plane.
- The NAS dataset layout and mount contract (working Company File checkout,
  shared workbench, browser profiles), and the delta-sync agent that tracks
  the verified head.
- Screen attach/detach: per-staff desktop sessions, the shell UX for
  watching and driving them, and the one-task-per-screen scheduling rule.
- Placement and multi-node: which node hosts which Company Computer, GPU
  scheduling, and migration by share reattachment.

## Ratified decisions

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

- Screen transport (Wayland/RDP/SPICE/VNC) and how sessions are recorded
  into the audit trail.
- Publication cadence from the working copy: per task, per explicit "commit"
  action, or continuous proposals.
- Verified-snapshot bounds: the snapshot contract currently caps 50,000
  files / 1 TiB; the working store is unbounded, and raising the published
  bounds is a deliberate decision when a company approaches them.
- Whether the control plane remains hosted or moves to owned infrastructure
  — the availability incidents of 2026-08-25 are the motivating record; any
  move must preserve the single-writer coordination model.
