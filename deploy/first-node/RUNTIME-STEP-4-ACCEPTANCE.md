# Step 4 acceptance ledger

Local implementation and verification of the enabled candidate are complete; production acceptance and release remain unapproved. The [final Steps 0–4 local audit](RUNTIME-STEPS-0-4-LOCAL-AUDIT.md) records the requirement map, fresh regressions and explicit live gates. Historical checkpoint notes describe the state at their own dates; they must not override this status. The canonical specification is `/Users/jonas/work/Qorpera_Base-runtime/QORPERA-RUNTIME-CONTRACT.md`, sections 12 and 19.

## Current local evidence

| Requirement | Evidence and limits |
| --- | --- |
| Headless execution, shared desktop/web APIs | The runtime, browser SDK and independent static web app pass the actual entrypoint bundle boundaries. Runtime: 147 source files/268 bundle inputs; SDK: 72 browser inputs; web: 78. Both clients submit scoped intent and display results; neither owns cloud execution or computer lifetime. |
| Governed Company File, explicit binary transfers | Actual native receipts, PostgreSQL, office TLS, contained Linux reads/writes and disk object gateway compose export, import and exact-version Company File publication. Ordinary writes advance one head; protected writes remain proposals. Source hashes, retention and original receipt provenance survive office closure. |
| Human approval of a native binary proposal | No current local evidence. The packaged web review proof was deleted in the legacy sweep, and the object gateway's member file export route it downloaded through is gone (E3). |
| Typed realm separation | Runtime and SQL tests explicitly refuse `isolated_worker` sources/destinations before authority/storage/workbench I/O. Raw paths, member-device substitutions, arbitrary hashes, stale versions, corrupt bytes and revoked authority are also refused. This is refusal of an unsupported lane, not implementation of worker transfer. |
| Multiple desktops and client-independent office work | The combined Linux probe now uses actual PostgreSQL/native receipts for two staff runs and two persistent XFCE desktops, with zero member clients running. Native session closure preserves both desktops. Separate totals, shared-file consumption, browser reconciliation, binary export, canonical publication and exact live Company File import pass together. Guest-adapter reconstruction preserves both the report and original canonical binary. Adoption/readiness remain fixtures; this is not VM reset. See `RUNTIME-OFFICE-COMBINED-PROOF.md`. The earlier whole-guest probe separately covers an actual viewer disconnection and privacy-barrier restoration with fixture native authority. |
| Browser/profile and viewer lifetime | The combined probe navigates a fixture application in real Chromium, fills two totals, clicks Reconcile and reads 40 through the browser snapshot tool under actual native SQL authority. Page content and prior sign-in preparation are fixtures; owner consent and continuing grants use SQL. Earlier Chromium probes separately cover sticky synthetic cookies, containment and privacy cleanup. Actual packaged web plus SQL/TLS/noVNC covers human watch/control and private sign-in, with guest pixels and physical acknowledgements as fixtures. |
| Office authority, privacy, capacity ceiling and concurrency | The full registry driver passes after 192 migrations, including actual Linux export/import/publication and desktop input/capture. It covers one driver per screen, duplicate effects, private-state races, concurrent native/office reservations, retained allocations and exact deletion-based release. Guest provisioning/mount admission remain fixtures. |
| Node ledger and office/native dispatch admission | The node SQL driver passes after 193 migrations: exact host/provider/resource binding, CPU/RAM headroom, one winner for the final slot across companies, stale health after lock waits, retained pending demand and database restart. Office create/first-boot/resume and native job create/first-boot require that gate. Actual native-provider/SQL tests recover lost replies and health loss before boot into one created VM, one boot and one deletion, preserving identity storage. Repeated office lifecycle tests retain one charged reservation across boots. Hardware, VM and root effects remain fixtures. Login dispatch now also enforces the shared ledger: the actual gateway and all 194 migrations recover eight gates, database restart, lost stop/release replies and client-independent cleanup into one VM/start/deletion with identity storage retained. Migration 039 now joins the actual complete-host reader/publisher to PostgreSQL and Unix HTTP after 195 migrations. Hardware-only observations, changed ledger snapshots, unknown computers and substituted physical identity block readiness; stopped/absent machines remain charged. Actual non-root Linux custody and jitless TLS are tested separately. Daemon/VM observations remain fixtures; production installation and enrollment remain unaccepted. |
| Boot and service lifecycle | Prior proofs cover journaled startup, retained stop history, repeated SQL/provider VM cycles and actual packaged systemd controls on fresh boots. VM power observations and earlier boot history are synthetic where recorded. These are evidence for the stated components, not the combined canonical-company reset proof. |
| Canonical state after physical guest loss | `--combined-rebuild` removes the first Linux container and its workbench, restarts PostgreSQL and recovers both live files into a new container. Five physical canonical objects retain their exact hashes; the current tree matches live SQL paths and all file chunks restore. No canonical bytes are restaged. The Company File, snapshot, path entries and charged allocation remain unchanged; released screen leases are refused. Actual LXD boot/adoption and NAS durability are not exercised. See `RUNTIME-OFFICE-COMBINED-PROOF.md`. |
| Independent host observer installation | The five-artifact package includes a protected root installer, fixed service/CA paths and dedicated service identity. Twenty-one actual-systemd checks pass with no external network: immutable installation, real kernel locks, inactive/disabled defaults, zero-capability TLS polling, restart/crash recovery, failed/stalled daemon scans, retained-state and override refusal, actual kernel health collection, independent diagnostic export and hung-child recovery. Registry and LXD are fixtures; live installation/enrollment remain unaccepted. See `NODE-OBSERVER-INSTALLATION.md` and `RUNTIME-NODE-HEALTH.md`. |
| Physical screen lifecycle publication and usage | The production Linux guest binds shared/private events to its admitted boot/invocation identity. All 199 SQL migrations pass publisher replay, private discovery, bounded heartbeat estimates, unknown gaps, clipped/partitioned arithmetic and database restart. The real provider stop adapter/SQL acknowledgement caps a lost guest's lifetime without inventing a close event or releasing capacity; root measurements remain fixtures. A separate real Linux guest probe verifies six lifetimes against a fixture registry. The production private disk queue now preserves exact events through reopen and decouples SQL delivery from launch/work/drain; the real Linux probe passes all six lifetimes with export offline. Actual systemd separately preserves private state through two restarts. Actual publisher/disk-queue/PostgreSQL recovery now retains 11 observations after authority revocation and stop, with exact hashes, separate unconfirmed receipts, operator discovery, unchanged canonical history/allocations and database restart. Destructive VM/root maintenance custody remains unaccepted; the enabled supervisor preserves its root and holds replacement requests. See `RUNTIME-OFFICE-RETENTION.md`. |

The retained computer control lifecycle now has a service-only query in migration
`20260909000500_runtime_computer_lifecycle.sql`. It separates admission, service,
boot requests and capacity release, preserves database source times and keeps
physical sample estimates separate. Exact VM transition timestamps remain
unavailable. The control-record projection and forward provider-operation
timestamps have separate, explicit time sources. See
`RUNTIME-COMPUTER-LIFECYCLE.md`.

New local office VM operation records now retain provider-clock timestamps for
dispatch, acceptance and first observed terminal outcome. The reader preserves
original v1 bytes and mixed chains, and the packaged `--journal-history` command
provides a read-only identity/time/reason view. Clock failure is explicit;
sequence remains authoritative across clock corrections. These are operation
record times, not exact physical transition timestamps or service readiness.
See `RUNTIME-PROVIDER-OPERATION-HISTORY.md`.

The current-allocation operator page is also implemented in migration
`20260909000600_runtime_node_computers.sql`: pending capacity and refusals,
immutable placement, fresh physical states, active-job versus no-recorded-job
classification and explicit uncertainty. The 201-migration inventory probe
passes these cases with actual publication/admission/release and fixture
physical measurements. Separate node-health and observed-human-activity queries
are now implemented; see `RUNTIME-NODE-HEALTH.md`, `RUNTIME-COMPUTE-USERS.md` and
`RUNTIME-NODE-COMPUTERS.md` for their distinct sources and freshness limits.

The full-host operator view is implemented in migration
`20260909001000_runtime_host_inventory.sql`. It includes managed, infrastructure
and unmanaged entries, original observation identity/time and immutable entry
pagination. Missing, stale, superseded, policy-changed and unavailable evidence
cannot imply current physical state or free capacity. The actual inventory
reader/publisher/SQL probe passes 205 migrations, including unmanaged stopped
machines, daemon outage, substituted identity, paged historical retention and
database restart. Physical host/daemon values remain fixtures. See
`RUNTIME-HOST-INVENTORY.md`.

Evidence roots in the task workspace:

- `outputs/step4-native-binary-review`: eight proof outputs, 192 migrations, inspected web review, unchanged implementation/package hashes.
- `outputs/step4-transfer-workloads`: 122 named tests across four files; full registry SQL/Linux driver; extended whole-guest Linux workload and reconstruction proof.
- `outputs/step4-screen-publisher`: production Linux lifecycle hooks, publisher/SQL lost-reply recovery, separate six-lifetime physical probe, targeted regressions and refreshed offline packages.
- `outputs/step4-screen-recovery`: historical startup-bound unconfirmed retention, exact outbox recovery after SQL revocation/stop, operator discovery, bounded conflict guards and refreshed offline packages.
- `outputs/step4-screen-outbox`: private durable custody, local transition validation, six physical lifetimes with export offline, exact replay after reopen, actual systemd state preservation and refreshed offline packages.
- `outputs/step4-screen-history`: operator discovery and screen usage, provider-confirmed termination of a missing guest, bounded/private/read-only SQL cases and refreshed runtime packages.
- `outputs/step4-node-capacity`: node admission and office dispatch checkpoint; 141 named tests across five files, package regression, PostgreSQL contention/restart proof and repeated office VM lifecycle composition. The source bundle and offline Linux packages are updated; this is incomplete host-wide admission.
- `outputs/step4-native-node`: native job admission checkpoint; 241 named tests across nine files, actual governed-native-provider/PostgreSQL recovery proof after 193 migrations, full repository check and five verified offline Linux packages. Login VM accounting and full host inventory remain open.
- `outputs/step4-member-web-composition`, `outputs/step4-member-web-office`, and `outputs/step4-member-web-sql`: packaged web composition with fixture boundaries explicitly recorded.
- `outputs/step4-vm-sql` and `outputs/step4-boot-sql-systemd`: historical lifecycle proofs; consult their manifests before reusing hashes.

## Implementation audit and remaining live acceptance

Office-provider diagnostics now carry protected public computer/provider/host,
policy and guest-package identity with original observation time and safe phase
outcomes. Failed or stalled log writers cannot terminate reconciliation or queue
unbounded diagnostics. Nineteen actual-systemd installer checks include journal
identity and registry-outage recovery; registry authority is synthetic idle only.
See `RUNTIME-PROVIDER-DIAGNOSTICS.md`. These logs do not establish exact physical
transition times. The service-only compute-request query now combines retained
office/login/native demand before allocation, company/node refusals, placement
and typed dispatch failures. Actual admission/release RPCs pass 204 migrations
and database restart. Historical failure times remain unknown; new database
failure transitions retain their first time. Offered dispatch rows and physical
host measurements are fixtures. Physical provisioning failures remain in provider
diagnostics. See `RUNTIME-COMPUTE-REQUESTS.md` for coverage and access limits.

The service-only `qorpera_runtime_compute_users` query now separates current
distinct allocated computers, companies and associated members from observed
human activity in an explicit window. Real viewer redemption/input authority
tests pass all 203 migrations, deduplicate people, retain ended/revoked history,
fence placement/generation changes and preserve records through database restart.
Host/allocation placement remains a fixture; continuous presence is unmeasured.
See `RUNTIME-COMPUTE-USERS.md` for source and coverage limits.

1. **Complete host-wide admission and operational visibility.** `20260908003700_runtime_node_capacity.sql` adds the shared node ledger, CPU/RAM/headroom policy, immutable costs, fresh observation checks, pending demand and a consistent whole-slot operator query. Office and native job dispatch enforce it. Login VM allocation and cleanup now enforce the same ledger, with an immutable operation journal and unattended cleanup that preserves the identity disk. The headless publisher binds complete all-project LXD inventory to protected host/socket evidence, current SQL allocations and reviewed infrastructure headroom. Inventory receipts gate both dispatch and reported slots. Separate operator queries now expose allocated computer state, placement, recorded job activity, node health, distinct membership/observed human activity and retained requests before allocation. Typed dispatch failures are queryable; physical provider failures remain in protected diagnostics. The full-host query now includes infrastructure and unmanaged instances with explicit observation freshness and stable historical paging. Initial production inventory review, protected service installation and actual-host acceptance remain required; existing pre-ledger VMs cannot silently disappear from the budget. See `RUNTIME-NODE-CAPACITY.md` for the implemented boundary and explicit access/retention.
2. **Computer/screen usage accounting.** Service-only computer history binds physical samples to original allocation/placement and confirmed release, with bounded running/suspended estimates and missing/stale/invalid intervals. Screen history separately projects retained guest lifetimes with a 15-second maximum heartbeat hold, explicit unknown gaps and provider-confirmed absence. Both declare their estimate method and coverage; desired power and `touched_at` are not measured usage. The retained computer control-record view and forward provider-operation journal now preserve their distinct original times. Exact physical transition instants remain unmeasured and must not be reconstructed from observation or filesystem times. Delayed screen observations have separate immutable, explicitly unconfirmed retention and operator queries. Production lifecycle recording waits for private local disk custody while export runs independently. Unacknowledged events remain retained, skipped heartbeat intervals remain unknown, and separately retained observations are excluded from canonical usage. Custody through destructive VM/root maintenance remains unproved and outside the enabled lifecycle; see `RUNTIME-OFFICE-RETENTION.md`. Independent node health now collects CPU time, available RAM, root filesystem space and network counters, with immutable SQL receipts and original-time freshness. It cannot block inventory polling or affect admission. NAS health and network reachability remain unknown; see `RUNTIME-NODE-HEALTH.md`.
3. **Combined ordinary workload — local proof complete.** `scripts/test-runtime-office-linux.mjs --combined` passes 205 migrations, two actual native staff runs, two persistent XFCE desktops, browser reconciliation, one exact binary canonical publication and live Company File import with zero member clients running. SQL retains 18 completed receipts and no active resources or screen leases. Physical adoption/readiness, prior browser sign-in and page content remain fixtures. This closes the local composition gap; actual VM/NAS acceptance remains a live gate. See `RUNTIME-OFFICE-COMBINED-PROOF.md`.
4. **Canonical company preservation through reset — local guest-loss proof complete; actual VM acceptance remains.** The combined rebuild mode now discards the entire Linux container and workbench, restarts PostgreSQL and restores the exact canonical head closure: five objects, two files and 13 bytes, with no restaging. Actual SQL runner/provider renewal keeps the runs authorized; old released screen leases remain refused and the same machine reservation remains charged. Fresh guest-adapter and object-gateway instances serve the recovered files. Existing provider lifecycle and systemd proofs separately exercise fresh-boot admission/control and intended working-state retention. This container proof does not establish actual LXD/NAS reset, adoption, host-failure durability or browser-profile preservation; those remain explicit live gates.
5. **Final Steps 0–4 local review — complete.** The final audit passes 717 focused tests across 25 files and current 205-migration SQL context/wake, secret-custody and Company File transaction-recovery checks. Source closure, headless/browser boundaries and all available package artifacts are reverified. The enabled office lifecycle preserves its root; replacement stops and remains held. [The retention audit](RUNTIME-OFFICE-RETENTION.md) separates this supported behavior from unimplemented destructive maintenance and host-loss recovery. No new production-code finding remains from this local review. Actual-host/client/signing gates below are not accepted by these tests.

## Scope and live gates

Order 5 owns worker dispatch, todos and completion; Order 9 owns isolated coding VMs and PR continuity. Additional company machines and the full host-failure programme are explicitly later work. Section 12.2 still governs every enabled transfer: future worker adapters must carry immutable identity, current authority and provenance; office paths cannot be reused implicitly.

Hosted PKCE/proxy/TLS/Realtime, installed Electron chooser/viewer behavior, actual LXD/virtiofs/NAS, required storage durability and final signed external native artifacts remain live acceptance gates. Local fixtures cannot establish those results. No release, signing, deployment, publication, production/NAS mutation or paid model call is performed by these proofs.
