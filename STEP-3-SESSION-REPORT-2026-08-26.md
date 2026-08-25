# Step 3 Company Computers — session report (2026-08-26)

Produced by the dedicated Step 3 session continuing from
`STEP-3-SESSION-REPORT-2026-08-25.md`. Branch `step3/company-computers` at
`5fabd89d3` (4 commits on `439fadc1c`, all pushed to `github`); tsgo clean,
biome clean; 12 new shell sync tests, provider suite grown 6 → 10, full
runner-orchestrator suite 61 passing, targeted shell suites (sync + merge +
snapshot) 34 passing. Nothing applied to any Supabase project, no PR opened.
`github/master` moved ahead during the session (10 commits, none touching the
scope-3 base files); the branch was deliberately not rebased mid-work.

## What was built

**1. Delta-sync agent (scope 3 — complete).** `0ca6465f5`
`packages/shell/src/cloud-company-computer-sync.ts` + colocated test.
- `syncCloudCompanyComputerCheckout`: one-directional fast-forward of the
  standing checkout toward the verified head over a caller-supplied
  `CloudContentAddressedStore`, diffed with the additively exported
  `sameEntry`/`entryMap`/`comparePath` from `cloud-company-merge.ts`.
- Head resolver interface + `hostedCompanyComputerHeadResolver` enforcing
  head = `qorpera_company_files.head_snapshot_id`, ready-state only, and
  `publicationState === "published"` (a non-published head throws).
- Divergence guard: destructive transitions (overwrite, delete) require the
  disk state to match the last-applied record exactly; diverged paths are
  skipped and reported; reconciliation stays with capture/proposal.
- Schema-tagged atomic state (`qorpera.company-computer-sync/v1`) at the
  bootstrap-supplied `state_path`; staging under
  `companyRoot/.qorpera/w/cloud-sync-*` with stale-staging cleanup that never
  touches `cloud-merge-*` recovery journals; optional runtime-lock pattern
  mirrored from the merge path.
- `parseCloudCompanyComputerSyncConfig` + `runCloudCompanyComputerSyncAgent`
  consume exactly the `sync` block of `qorpera.company-computer-bootstrap/v1`
  (`company_root`, `state_path`, `poll_seconds`); unknown keys ignored for
  rolling upgrades. `initializeCloudCompanyComputerCheckout` prepares the
  checkout leaf (mkdir leaf-only + `git init`, required by the runtime lock)
  and fails closed when the dataset parent is not mounted.

**2. NAS dataset snapshot in the snapshotting window.** `2473e290c`
- `CompanyDatasetSnapshotClient` contract; the provider's `snapshotComputer`
  captures the dataset before the LXD root snapshot and fails closed if the
  working world cannot be captured; the closing lifecycle event records
  `dataset_captured` so a root-only snapshot never poses as a recovery point.
- `ExecCompanyDatasetSnapshotClient`: deployment-agnostic adapter running a
  command template (`{dataset}`/`{snapshot}` substituted per argument, no
  shell, both values pattern-locked). Client is optional; deployed behavior
  without it is unchanged byte-for-byte.

**3. Member read policies (draft migration, applied nowhere).** `763d8cf35`
`supabase/migrations/20260826020000_company_computer_read_policies.sql` —
member SELECT on `qorpera_company_computers` and
`qorpera_company_computer_events` via `qorpera_can_read_profile` (charter's
shared-visibility default); writes stay behind the RPCs; the node registry
stays service-plane only.

**4. Screens decision material (no implementation).** `5fabd89d3`
`deploy/first-node/STEP-3-SCREENS-DECISION.md` — transport options (per-screen
TigerVNC/XFCE + noVNC recommended; Wayland/wayvnc, xrdp, LXD console
evaluated) and audit options (transcript events + periodic content-addressed
keyframes recommended) with fixed constraints and the unblock list. Charter's
open question now points at it. **PENDING FOUNDER DECISION** — the screens
slice stays unbuilt until ratified.

## Design decisions (charter trace)

- Sync is strictly one-directional; the working copy is never authority
  (principle 4). The divergence guard doubles as crash recovery: adopt-first
  ordering means an interrupted apply self-heals on the next poll with no
  journal or rollback machinery.
- Deletions are gated by `cloudCompanyPathBelongsToLogicalTree`: paths the
  current tree contract omits are machine-local state and are dropped from
  tracking, never deleted from disk. A head with an older tree contract than
  the applied state refuses to sync (would read omissions as mass deletions).
- Any sync-state corruption or loss degrades to adopt-or-skip — it can never
  cause local work to be overwritten.
- Dataset-first snapshot ordering inside the lifecycle window (principle 3:
  the dataset is the working world; the VM root is disposable).

## Blocked / deferred (with reasons)

- **Member subscriptions on the shared machine** (pickup item 4, founder-
  ratified 2026-08-25): extend the turn-RPC capsule rule (migration
  `20260821001000` ~lines 1024/1039) and `validateCloudRunnerWork`
  (orchestrator.ts ~line 1117) — **strictly after Step 2 acceptance closes**;
  payment structure stays out of the contracts.
- **Screens slice implementation** — blocked on the founder decision above.
- **Guest service wiring for the sync agent**: the module, config parser, and
  poll loop exist; the guest systemd unit that reads
  `/var/lib/qorpera-bootstrap/company-computer.json` and composes the hosted
  primary head resolver + broker signed-URL object store from the bootstrap
  credentials is the remaining integration, best built alongside the image
  packaging pass.
- **Runner session re-activation after VM reboot past `pending`** — deferred
  deliberately this session: it changes runner-registration lease semantics
  shared with the Step 2 acceptance currently in flight in the parallel
  session; touching those contracts now risks the acceptance run.
- Idle power management for persistent VMs; pgTAP for the migrations
  (unrunnable until applied somewhere).

## NEXT SESSION PICKUP

1. Read this report; charter and Step 2 architecture as before.
2. If the founder has ratified STEP-3-SCREENS-DECISION.md: build the screens
   slice in its "What a decision unblocks" order (screens registry migration
   → guest screen agent in the image → shell watch/drive surface → keyframe
   artifacts).
3. If Step 2 acceptance has closed: implement pickup item 4 (capsule rule +
   work validator extension) as its own migration/PR, payment structure
   explicitly excluded.
4. Otherwise: guest service wiring for the sync agent (systemd unit + store/
   resolver composition), then runner reboot re-activation once the Step 2
   acceptance freeze lifts.
5. Consider folding `github/master` (10 commits ahead) into the branch before
   the next build block; nothing upstream conflicts with scope-3 files today.
