# Step 3 Company Computers — background-session wrap-up report (2026-08-25)

Produced by the initial background build session on its promotion to a
dedicated session. Branch `step3/company-computers` at `9493c7698`
(2 commits on `e29a709af`); tsgo clean, biome clean, 6 new tests passing,
33 existing runner-orchestrator tests regression-checked. Nothing applied to
any Supabase project, no PR opened.

## What was built

**1. Control-plane registry migration (scope 1 — complete).**
`supabase/migrations/20260826110000_company_computers.sql` — design
artifact, applied nowhere.
- `qorpera_compute_nodes` — cluster-scoped node registry (placement
  targets; active/draining/retired).
- `qorpera_company_computers` — one row per Company Computer: environment
  binding, unique `logical_computer_id`, pinned `nas_dataset`, lifecycle
  (`provisioning/active/snapshotting/migrating/recovering/retired`),
  `node_id` + `migration_target_node_id`; partial unique index enforcing one
  live computer per environment.
- `qorpera_company_computer_events` — lifecycle audit trail.
- Binding guard trigger: company-class logical computer, same profile,
  company-owned active compute identity, environment in profile.
- RPCs: `qorpera_register_company_computer` (member-authorized),
  `qorpera_company_computer_lifecycle` (service-role transition matrix;
  placement adoption on activation/migration/recovery; retirement mirrors
  Step 2 logical-computer retire effects incl. job terminalization),
  `qorpera_describe_company_computer` (service-role provider read).
- `create or replace` of `qorpera_execution_compute_available` adds a
  lifecycle dispatch gate that is vacuously true without a registry row —
  deployed Step 2 behavior byte-for-byte unchanged.

**2. Persistent provider lane (scope 2 — complete).**
- `packages/runner-orchestrator/src/lxd-company-computer-provider.ts` —
  `LxdCompanyComputerProviderBackend` implementing the existing
  `CloudRunnerProviderServiceBackend` contract: journal keyed by logical
  computer (not acquisition), stable runner reuse
  (`client_runner_id = logical_computer_id` through the idempotent
  `qorpera_provision_execution_runner`), pinned `company-dataset` disk
  device from the host NAS mount, dataset layout constants (`company/`,
  `workbench/`, `profiles/`, `.qorpera-computer/`), guest mount at
  `/srv/qorpera/dataset`, assignment fencing with expiry, non-destructive
  `stop()`, explicit `startComputer`/`stopComputer`/`snapshotComputer`,
  `SupabaseLxdCompanyComputerControlPlane` RPC client, bootstrap file
  contract `qorpera.company-computer-bootstrap/v1` reusing the Step 2
  capsule/native-bridge boundary and compute-identity volume unchanged.
- `packages/runner-orchestrator/src/lxd-client.ts` — additive
  `LxdInstanceSnapshotClient` interface + `createInstanceSnapshot`
  (stateless) on `LxdUnixClient`; `LxdClient` untouched.
- `packages/runner-orchestrator/test/lxd-company-computer-provider.test.ts`
  — 6 tests: provisioning + cross-run reuse + dataset pinning +
  provisioning→active, sandbox-work rejection, wrong-node rejection,
  migrating rejection, delivery fencing + stop-never-powers-off, snapshot
  lifecycle window.

## Design decisions (charter trace)

- Registry built around the existing `logical_computer_id` slot, not a new
  addressing path (principle 1; extend-don't-replace).
- Dataset pinned in the control plane; the provider resolves and never
  derives (principles 3, 5).
- `snapshotting` remains dispatchable; `migrating`/`recovering`/`retired`
  block dispatch.
- First acquire creates the VM and flips `provisioning → active` with node
  adoption — the first turn provisions naturally.
- No per-run acquisition binding — deliberately avoids the
  one-acquisition-per-run poisoning documented in the Step 2 handoff;
  re-dispatch re-ensures the standing machine idempotently.
- `stop()` never powers off the shared machine (principles 2, 6):
  revocation is capability denial in the control plane; sealed capsules
  leave no parked credentials to protect by force.
- Sync state lives on the dataset (`.qorpera-computer/`) so migration by
  share reattachment carries the sync cursor.

## OPEN FOUNDER DECISION — member subscriptions on the Company Computer

Step 2 encodes in two places that member-connection sponsorship cannot
drive company-owned compute identities: `validateCloudRunnerWork`
(orchestrator.ts ~line 1117) rejects `ownership_kind='company'` +
`sponsor.kind='member_connection'`, and the turn RPC's capsule check
(migration `20260821001000` ~line 1024) requires the native-subscription
capsule to belong to the turn's compute identity while ~line 1039 requires
the turn identity to equal the computer's pinned identity. Consequence: a
Company Computer today runs only under `company_service_account` /
`company_api_billing` sponsors. Charter principle 6 implies member
subscriptions should work on the shared machine — that requires a
deliberate extension of the turn-RPC capsule-ownership rule and the work
validator (capsule matched to the sponsor's member identity rather than the
computer's identity). Flagged, not silently decided; do not touch those
paths until Step 2 acceptance closes.

## Deferred

- Scope 3, the delta-sync agent (design ready — see pickup below).
- NAS dataset snapshot tooling inside the `snapshotting` window (LXD
  snapshot covers only the disposable VM root).
- Runner session re-activation after VM reboot once past `pending`.
- Screens/attach-detach and one-task-per-screen scheduling
  (`max_concurrency` stays 1), client RLS read policies for the new tables,
  pgTAP for the migration (unrunnable without applying).
- Idle power management for persistent VMs.

## NEXT SESSION PICKUP

1. Read this report plus `deploy/first-node/STEP-3-COMPANY-COMPUTERS.md`.
2. Build scope 3: `packages/shell/src/cloud-company-computer-sync.ts` +
   colocated test. Reuse `readCloudCompanyTreeManifest` /
   `currentCloudCompanyTreeReference` from `cloud-company-snapshot.ts`;
   additively export `sameEntry`/`entryMap`/`comparePath` from
   `cloud-company-merge.ts` for the diff; head resolver interface returning
   `{snapshotId, tree}` (head = `qorpera_company_files.head_snapshot_id`,
   published snapshots only); pulls via a caller-supplied
   `CloudContentAddressedStore` (broker signed-URL transport already
   implements the transport contract); one-directional apply with a
   local-divergence guard (only fast-forward files whose disk hash matches
   the last-applied state; skipped paths reported; reconciliation stays with
   capture/proposal); state file at
   `<dataset>/.qorpera-computer/company-sync.json` (schema-tagged atomic
   JSON like `cloud-company-substrate.ts`); `claimCompanyRuntimeLock`
   around apply (mirror `cloud-company-merge.ts` optional-lock pattern);
   transaction dir under `companyRoot/.qorpera/w/`; tests with
   `MemoryObjectTransport` + `scaffoldCompany` fixtures (see
   `cloud-company-snapshot.test.ts`).
3. The provider bootstrap already emits the sync agent's config block
   (`sync.company_root`, `sync.state_path`, `sync.poll_seconds` in
   `qorpera.company-computer-bootstrap/v1`) — consume exactly that.
4. ANSWERED by the founder (2026-08-25): members share one computer and it
   is the interface into the entire company — see "Ratified decisions" in
   the charter. Extend the turn RPC capsule rule + `validateCloudRunnerWork`
   in a new migration/PR strictly after Step 2 acceptance closes; keep the
   payment structure out of the contracts (explicitly undecided).
5. Then: NAS dataset-snapshot integration, screens slice, RLS read policies.
